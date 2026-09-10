# Tylliq Licensing Control Center

Licensing backend for Tylliq POS: Ed25519-signed device activation, device
limits, offline grace period, and the admin API behind business/license/
payment management. Deploys as Firebase Cloud Functions + Firestore.

The Flutter client lives in a separate repo (`shopsync_pos` / package
`tylliq_pos`) and only ever talks to `activateDevice` and `revalidateDevice`
(see `lib/license/` there). Everything else here is `admin*`-prefixed and
requires a Firebase Auth custom-claim role (see `src/admin_auth.js`).

## Setup

1. Install deps: `cd functions && npm install`.
2. Point `.firebaserc` at your Firebase project (already set to
   `tylliq-licensing`).
3. Generate the Ed25519 signing keypair (one-time, do this locally — never
   on a machine that also ships the Flutter app with the private half still
   present):
   ```
   node scripts/generate_signing_keypair.js
   ```
   - Paste the printed **public** key into the Flutter app's
     `lib/license/license_crypto.dart` (`publicKeyBase64`).
   - Set the printed **private** key as a Secret Manager secret:
     `firebase functions:secrets:set LICENSE_SIGNING_PRIVATE_KEY`. Never
     commit it anywhere.
4. Run the emulator: `npm --prefix functions run serve`.
5. Grant yourself an admin role: `node scripts/set_admin_claim.js`.
6. Deploy: `npm --prefix functions run deploy`.

## Admin console (frontend)

The admin console is a Vite app in `frontend/` that talks directly to the
deployed Cloud Functions (`frontend/src/api.js`), so it works against
production without the emulator running.

```
cd frontend
npm install
![alt text](image.png)
```

This starts the dev server at `http://127.0.0.1:5174`. Sign in with an
account that has an admin role set (see step 5 above).

## Billing plan: on Blaze

This project runs on the **Blaze (pay-as-you-go)** plan — required for Cloud
Build, which every Cloud Function deploy needs regardless of 1st-gen vs.
2nd-gen (there's no Spark-compatible way to deploy a modern Cloud Function
at all; earlier revisions of this doc assumed otherwise and were wrong).
Every function here uses the 2nd-gen API (`firebase-functions/v2/https`,
via `src/https_utils.js`), and the signing key lives in Secret Manager via
`defineSecret` in `src/activation.js`.

Blaze carries the *same* free monthly quota as Spark, so at realistic
traffic for this backend (device activations/revalidations across up to a
few hundred shops, a handful of admin panel users) actual spend is
expected to be **$0/month** — see the cost-controls section below for what
keeps it that way.

## Cost controls

Three defenses, layered:

1. **`maxInstances` on every function** (`src/https_utils.js`) — hard caps
   how many concurrent instances any one function can scale to (20 for the
   public device-facing endpoints, 10 for everything admin-facing). This is
   the actual ceiling on worst-case cost from a bug, a retry loop, or abuse
   — independent of whether the defenses below catch it.
2. **App Check on the four public, otherwise-unauthenticated endpoints**
   (`activateDevice`, `revalidateDevice`, `listMyDevices`,
   `deactivateMyDevice` — see `src/app_check_utils.js`) — verifies the
   caller is the real Flutter app, not a script. **Enforcement is OFF by
   default** (`ENFORCE_APP_CHECK` unset): missing/invalid tokens are logged
   but the request still proceeds, so this can deploy ahead of the client
   rollout without breaking activation for existing shops. Only set
   `ENFORCE_APP_CHECK=true` (as a secret or env var) once (a) the Flutter
   app has shipped with App Check wired in
   (`lib/license/license_api_client.dart`), *and* (b) Play Integrity is
   enrolled for the app in Play Console — until enrolled, App Check falls
   back to a debug token real users' devices can't produce, and enforcing
   would lock everyone out.
3. **Rate limiting on `activateDevice`** (`src/rate_limit.js`) — caps
   activation attempts to 20/hour per IP, since `licenseKey` is a
   brute-forceable secret an attacker could otherwise guess by hammering
   this endpoint (unlike `revalidateDevice`'s `deviceSecret`, a random
   32-byte token that isn't realistically guessable).

Also worth setting up manually, outside this repo: a **budget alert** on
the billing account backing `tylliq-licensing` (Google Cloud Console →
Billing → Budgets & alerts), so you get an email if spend ever climbs,
however unlikely.

## Project layout

```
functions/src/
  activation.js            activateDevice, revalidateDevice (public, unauthenticated)
  self_service.js          listMyDevices, deactivateMyDevice (public, licenseKey-gated)
  admin_auth.js             requireRole/requireAdmin - Firebase Auth custom-claim roles
  business_management.js   adminCreateBusiness, adminGetBusiness, ...
  license_management.js    adminCreateLicense, adminUpdateLicense, ...
  device_management.js     adminListDevices, adminDeactivateDevice
  plans_management.js      adminCreatePlan, adminUpdatePlan, adminListPlans
  features_management.js   adminCreateFeature, adminListFeatures
  payments_management.js   adminRecordPayment, adminSetPaymentStatus, ...
  dashboard_stats.js       adminGetDashboardStats
  audit.js                 writeAuditLog + adminListAuditLog
  crypto_utils.js           Ed25519 signing, canonical cert JSON, hashing
  redact.js                 strips sensitive fields before admin responses
  https_utils.js            onRequest wrapper applying the maxInstances cap
  app_check_utils.js        App Check verification (public endpoints only)
  rate_limit.js             per-IP attempt limiting for activateDevice
functions/scripts/
  generate_signing_keypair.js   one-time Ed25519 keypair generation
  set_admin_claim.js            grants a Firebase Auth user an admin role
  admin_cli.js                   CLI wrapper around the admin* endpoints
```
