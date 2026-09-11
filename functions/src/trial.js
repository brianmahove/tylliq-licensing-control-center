// Shared trial-license logic - used by both the admin HTTP API
// (license_management.js, for the dashboard) and the CLI
// (scripts/admin_cli.js) so "mint a trial key" has exactly one definition
// instead of two copies that can drift apart. Deliberately has no
// firebase-functions dependency (callers pass in `db`) so the CLI (a plain
// Admin SDK script) can require it without pulling in the Functions runtime.

const TRIAL_PLAN_ID = 'trial';
const TRIAL_PLAN_NAME = '7-Day Free Trial';
// A trial is capped to exactly the starter plan's features - never
// "everything", never whatever the caller happens to pass in - so it always
// tracks whatever "starter" is currently defined as instead of a second,
// separately-maintained feature list that can drift out of sync.
const TRIAL_BASE_PLAN_ID = 'starter';
const TRIAL_DAYS = 7;
const TRIAL_MAX_DEVICES = 1;

/**
 * The fields that make a license doc a trial: a fixed plan/device-limit/
 * expiry/feature-set, plus the claim-tracking fields activateDevice uses to
 * enforce "activates exactly once, ever" (see activation.js's
 * activateTrialDevice).
 * @param {Date} issuedAt
 * @param {string[]} features the starter plan's current features
 */
function trialLicenseFields(issuedAt, features) {
  return {
    planId: TRIAL_PLAN_ID,
    maxDevices: TRIAL_MAX_DEVICES,
    expiresAt: new Date(issuedAt.getTime() + TRIAL_DAYS * 86400000).toISOString(),
    features: [...features],
    isTrial: true,
    trialClaimed: false,
    trialClaimedByDeviceId: null,
    trialClaimedAt: null,
  };
}

async function resolveTrialFeatures(db) {
  const snap = await db.collection('plans').doc(TRIAL_BASE_PLAN_ID).get();
  if (!snap.exists) {
    throw new Error(`Create the "${TRIAL_BASE_PLAN_ID}" plan before issuing trials - a trial always grants exactly its features, never more.`);
  }
  const { features } = snap.data();
  return Array.isArray(features) ? features : [];
}

/**
 * Keeps a `plans/trial` doc around purely so the admin dashboard (which
 * looks up a license's planId against the `plans` collection for display)
 * shows "7-Day Free Trial" instead of the raw string "trial", and so it
 * shows up in the Plan filter dropdown. Never read by activation.js - the
 * license doc itself is the source of truth for what a given trial grants.
 * Re-syncs `features`/`maxDevices` on every trial issuance in case the
 * starter plan changed, but leaves a since-customized `name` alone.
 */
async function ensureTrialPlanDoc(db, features) {
  const ref = db.collection('plans').doc(TRIAL_PLAN_ID);
  const snap = await ref.get();
  const now = new Date().toISOString();
  if (!snap.exists) {
    await ref.set({
      name: TRIAL_PLAN_NAME,
      priceCents: 0,
      currency: 'USD',
      billingPeriod: 'trial',
      maxDevices: TRIAL_MAX_DEVICES,
      features,
      productId: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await ref.update({ features, maxDevices: TRIAL_MAX_DEVICES, updatedAt: now });
  }
}

/**
 * The one entry point both call sites (adminCreateLicense and the CLI's
 * create-license --trial) use to mint a trial: resolves the current starter
 * features, keeps the display-only trial plan doc in sync, and returns the
 * fields to merge into the new license doc.
 * @param {FirebaseFirestore.Firestore} db
 * @param {Date} issuedAt
 */
async function mintTrialLicenseFields(db, issuedAt) {
  const features = await resolveTrialFeatures(db);
  await ensureTrialPlanDoc(db, features);
  return trialLicenseFields(issuedAt, features);
}

/**
 * Manual, audited recovery for the one legitimate failure mode a strict
 * single-use trial creates: activateDevice's transaction committed (license
 * claimed, device doc + secret created) but its response never reached the
 * app - dropped connection, crash before storage. The device is left
 * holding a trial it can never prove it received, and normal activation
 * will keep rejecting it with "trial_already_used" forever.
 *
 * This does NOT grant a new trial: it deletes the device doc and the
 * permanent trialDeviceLocks entry for the SAME device that originally
 * claimed this SAME license, and un-claims the license, so that one device
 * can redo the handshake - same license, same 7-day expiry (already
 * ticking since original issuance), still single-use once it succeeds.
 * There is no way to point this at a different device or a different
 * license than the one already on file.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} licenseId
 * @return {Promise<{deviceId: string, businessId: string}>}
 */
async function resetTrialClaim(db, licenseId) {
  const licenseRef = db.collection('licenses').doc(licenseId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(licenseRef);
    if (!snap.exists) throw new Error('License not found.');
    const license = snap.data();
    if (!license.isTrial) throw new Error('Not a trial license.');
    if (!license.trialClaimedByDeviceId) throw new Error('This trial has not been claimed by any device - nothing to reset.');

    const deviceId = license.trialClaimedByDeviceId;
    tx.delete(db.collection('devices').doc(deviceId));
    tx.delete(db.collection('trialDeviceLocks').doc(deviceId));
    tx.update(licenseRef, {
      trialClaimed: false,
      trialClaimedByDeviceId: null,
      trialClaimedAt: null,
      updatedAt: new Date().toISOString(),
    });
    return { deviceId, businessId: license.businessId };
  });
}

module.exports = {
  TRIAL_PLAN_ID,
  TRIAL_PLAN_NAME,
  TRIAL_BASE_PLAN_ID,
  TRIAL_DAYS,
  TRIAL_MAX_DEVICES,
  trialLicenseFields,
  resolveTrialFeatures,
  mintTrialLicenseFields,
  resetTrialClaim,
};
