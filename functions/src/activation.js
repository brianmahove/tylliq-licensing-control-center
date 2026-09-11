const { defineSecret } = require('firebase-functions/params');
const { onRequest, PUBLIC_MAX_INSTANCES } = require('./https_utils');
const { db } = require('./firebase_admin');
const { ok, fail, sendJson } = require('./response_utils');
const { withCors } = require('./cors_utils');
const { writeAuditLog } = require('./audit');
const { signCertificate, randomToken, sha256Hex } = require('./crypto_utils');
const { effectiveStatus } = require('./license_status');
const { requireAppCheck } = require('./app_check_utils');
const { checkActivationRateLimit } = require('./rate_limit');

// The Ed25519 private key never leaves this secret - not in source, not in
// an env var checked into anything, not in any client (see
// scripts/generate_signing_keypair.js). Only these two public endpoints
// (and nothing admin-facing) ever touch it.
const LICENSE_SIGNING_PRIVATE_KEY = defineSecret('LICENSE_SIGNING_PRIVATE_KEY');
const CERT_VERSION = 1;

function buildCertificate({ license, licenseId, deviceId, now }) {
  return {
    licenseId,
    businessId: license.businessId,
    deviceId,
    planId: license.planId,
    issuedAt: new Date(license.issuedAt).getTime(),
    expiresAt: license.expiresAt ? new Date(license.expiresAt).getTime() : null,
    maxDevices: license.maxDevices,
    features: [...(license.features || [])].sort(),
    status: effectiveStatus(license, now.getTime()),
    certVersion: CERT_VERSION,
    serverTime: now.getTime(),
  };
}

// Mirrors kClockRollbackHardLockCount / kClockRollbackHardLockMagnitude in
// the client's lib/license/license_local_store.dart - the client only ever
// reports this once it has crossed into "at least one rollback detected",
// but severity here still needs the same thresholds to know whether that's
// a single minor blip or the escalated case the client is now hard-locked
// over.
const CLOCK_ROLLBACK_HARD_LOCK_COUNT = 3;
const CLOCK_ROLLBACK_HARD_LOCK_MAGNITUDE_MINUTES = 7 * 24 * 60;

/**
 * Turns the optional `clockIntegrity` block a device sends on
 * activate/revalidate into the fields persisted on its `devices/{id}` doc,
 * so the admin dashboard can show a per-device clock-tamper history instead
 * of only ever seeing the device's current (self-reported, and thus
 * resettable) state.
 */
function clockIntegrityFields(clockIntegrity, now) {
  if (!clockIntegrity || !clockIntegrity.rollbackCount) return {};
  const rollbackCount = Number(clockIntegrity.rollbackCount) || 0;
  const magnitudeMinutes = clockIntegrity.lastRollbackMagnitudeMinutes == null
    ? null
    : Number(clockIntegrity.lastRollbackMagnitudeMinutes);
  const severity = rollbackCount >= CLOCK_ROLLBACK_HARD_LOCK_COUNT ||
    (magnitudeMinutes != null && magnitudeMinutes >= CLOCK_ROLLBACK_HARD_LOCK_MAGNITUDE_MINUTES)
    ? 'high'
    : 'low';
  return {
    clockRollbackCount: rollbackCount,
    lastRollbackMagnitudeMinutes: magnitudeMinutes,
    clockIntegritySeverity: severity,
    lastRollbackReportedAt: now.toISOString(),
  };
}

async function findLicenseByKey(licenseKey) {
  const hash = sha256Hex(licenseKey);
  const snap = await db.collection('licenses').where('licenseKeyHash', '==', hash).limit(1).get();
  if (snap.empty) return null;
  return { licenseId: snap.docs[0].id, license: snap.docs[0].data() };
}

const TRIAL_REJECTION_MESSAGES = {
  trial_already_used: 'This trial has already been used.',
  trial_device_reuse: 'This device has already used a trial license.',
  device_bound_elsewhere: 'This device is already activated under a different license.',
};
const TRIAL_REJECTION_STATUS = {
  trial_already_used: 409,
  trial_device_reuse: 403,
  device_bound_elsewhere: 409,
};
const TRIAL_REJECTION_ERROR_CODE = {
  trial_already_used: 'already-exists',
  trial_device_reuse: 'permission-denied',
  device_bound_elsewhere: 'already-exists',
};

/**
 * Trial activation is deliberately NOT the same code path as a paid
 * activation: a paid device can re-activate idempotently (see the
 * `deviceSnap.exists` branch below in activateDevice), but a trial must
 * activate exactly once, ever - not even a retry from the same device that
 * just claimed it. So this claims the license and creates the device doc
 * atomically in one transaction, gated on two things that must both still
 * be false at commit time: the license's own `trialClaimed` flag (per-key,
 * "has this exact trial been used"), and a permanent `trialDeviceLocks/
 * {deviceId}` doc (across all trial keys ever, "has this device already
 * burned a trial") that a device deactivation/reset never clears.
 */
async function activateTrialDevice({ res, licenseId, license, deviceId, platform, appVersion, deviceLabel, clockIntegrity, now, ip }) {
  const licenseRef = db.collection('licenses').doc(licenseId);
  const deviceRef = db.collection('devices').doc(deviceId);
  const trialLockRef = db.collection('trialDeviceLocks').doc(deviceId);

  const result = await db.runTransaction(async (tx) => {
    const [licenseSnap, deviceSnap, lockSnap] = await Promise.all([
      tx.get(licenseRef), tx.get(deviceRef), tx.get(trialLockRef),
    ]);
    const freshLicense = licenseSnap.data();
    if (freshLicense.trialClaimed) return { rejected: 'trial_already_used' };
    if (lockSnap.exists) return { rejected: 'trial_device_reuse' };
    if (deviceSnap.exists) {
      const existing = deviceSnap.data();
      if (existing.licenseId !== licenseId || existing.businessId !== freshLicense.businessId) {
        return { rejected: 'device_bound_elsewhere' };
      }
      // An unclaimed trial's licenseId can't already be on this device's
      // doc unless a first activation raced this one and lost - treat it
      // the same as "already used" rather than refreshing its credentials.
      return { rejected: 'trial_already_used' };
    }

    const deviceSecret = randomToken();
    const clockFields = clockIntegrityFields(clockIntegrity, now);
    tx.set(deviceRef, {
      businessId: freshLicense.businessId,
      licenseId,
      platform, appVersion, deviceLabel,
      deviceSecretHash: sha256Hex(deviceSecret),
      activatedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      status: 'active',
      branchId: null,
      deactivatedAt: null,
      ...clockFields,
    });
    tx.update(licenseRef, {
      trialClaimed: true,
      trialClaimedByDeviceId: deviceId,
      trialClaimedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    tx.set(trialLockRef, {
      deviceId, licenseId, businessId: freshLicense.businessId,
      claimedAt: now.toISOString(),
    });
    return { rejected: null, license: freshLicense, deviceSecret, clockFields };
  });

  if (result.rejected) {
    const reason = result.rejected;
    await writeAuditLog({ type: 'activation_rejected', businessId: license.businessId, licenseId, deviceId, meta: { reason, isTrial: true, ip } });
    return sendJson(res, TRIAL_REJECTION_STATUS[reason], fail(TRIAL_REJECTION_ERROR_CODE[reason], TRIAL_REJECTION_MESSAGES[reason]));
  }

  const cert = buildCertificate({ license: result.license, licenseId, deviceId, now });
  const { payload, signatureBase64Url } = signCertificate(cert, LICENSE_SIGNING_PRIVATE_KEY.value());
  await writeAuditLog({ type: 'activation_approved', businessId: license.businessId, licenseId, deviceId, meta: { isTrial: true, ip } });
  if (result.clockFields.clockIntegritySeverity === 'high') {
    const meta = { ...result.clockFields, ip };
    await writeAuditLog({ type: 'clock_tamper_suspected', businessId: license.businessId, licenseId, deviceId, meta });
  }
  const { deviceSecret } = result;
  return sendJson(res, 200, ok({ certificatePayload: payload, signature: signatureBase64Url, deviceSecret, serverTime: now.toISOString() }));
}

/**
 * Public, unauthenticated. The licenseKey itself is the credential - there
 * is no client-supplied businessId anywhere in this request, so a customer
 * editing local data can't point their device at someone else's business
 * (see the "Why a licenseKey is the credential" note in
 * docs/LICENSING_ADMIN.md).
 */
exports.activateDevice = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  if (!(await requireAppCheck(req, res))) return;
  const { licenseKey, deviceId, platform, appVersion, deviceLabel = null, clockIntegrity = null } = req.body || {};
  if (!licenseKey || !deviceId || !platform || !appVersion) {
    return sendJson(res, 400, fail('invalid-argument', 'licenseKey, deviceId, platform, and appVersion are required'));
  }
  const ip = req.ip || req.headers['x-forwarded-for'] || null;
  if (!(await checkActivationRateLimit(ip))) {
    return sendJson(res, 429, fail('resource-exhausted', 'Too many activation attempts. Try again later.'));
  }

  const found = await findLicenseByKey(licenseKey);
  if (!found) {
    await writeAuditLog({ type: 'activation_rejected', deviceId, meta: { reason: 'invalid_license_key', ip } });
    return sendJson(res, 404, fail('not-found', 'License key not recognized.'));
  }
  const { licenseId, license } = found;
  const now = new Date();
  const status = effectiveStatus(license, now.getTime());
  if (status !== 'active') {
    await writeAuditLog({ type: 'activation_rejected', businessId: license.businessId, licenseId, deviceId, meta: { reason: `license_${status}`, isTrial: !!license.isTrial, ip } });
    return sendJson(res, 403, fail('failed-precondition', `This license is ${status}.`));
  }

  if (license.isTrial) {
    return activateTrialDevice({ res, licenseId, license, deviceId, platform, appVersion, deviceLabel, clockIntegrity, now, ip });
  }

  const deviceRef = db.collection('devices').doc(deviceId);
  const deviceSnap = await deviceRef.get();

  if (deviceSnap.exists) {
    const existing = deviceSnap.data();
    if (existing.licenseId !== licenseId || existing.businessId !== license.businessId) {
      await writeAuditLog({ type: 'activation_rejected', businessId: license.businessId, licenseId, deviceId, meta: { reason: 'device_bound_elsewhere', ip } });
      return sendJson(res, 409, fail('already-exists', 'This device is already activated under a different license.'));
    }
    // Idempotent re-activation of the same device on the same license:
    // refresh its credentials, don't count it against the device limit again.
    const deviceSecret = randomToken();
    const clockFields = clockIntegrityFields(clockIntegrity, now);
    await deviceRef.update({
      status: 'active',
      platform, appVersion, deviceLabel,
      lastSeenAt: now.toISOString(),
      deviceSecretHash: sha256Hex(deviceSecret),
      deactivatedAt: null,
      ...clockFields,
    });
    const cert = buildCertificate({ license, licenseId, deviceId, now });
    const { payload, signatureBase64Url } = signCertificate(cert, LICENSE_SIGNING_PRIVATE_KEY.value());
    await writeAuditLog({ type: 'activation_approved', businessId: license.businessId, licenseId, deviceId, meta: { reactivated: true, ip } });
    if (clockFields.clockIntegritySeverity === 'high') {
      await writeAuditLog({ type: 'clock_tamper_suspected', businessId: license.businessId, licenseId, deviceId, meta: { ...clockFields, ip } });
    }
    return sendJson(res, 200, ok({ certificatePayload: payload, signature: signatureBase64Url, deviceSecret, serverTime: now.toISOString() }));
  }

  const activeCountSnap = await db.collection('devices')
    .where('licenseId', '==', licenseId)
    .where('status', '==', 'active')
    .count().get();
  if (activeCountSnap.data().count >= license.maxDevices) {
    await writeAuditLog({ type: 'activation_rejected', businessId: license.businessId, licenseId, deviceId, meta: { reason: 'device_limit_reached', ip } });
    return sendJson(res, 403, fail('resource-exhausted', 'Your device limit has been reached. Deactivate an existing device or upgrade your plan.'));
  }

  const deviceSecret = randomToken();
  await deviceRef.set({
    businessId: license.businessId,
    licenseId,
    platform, appVersion, deviceLabel,
    deviceSecretHash: sha256Hex(deviceSecret),
    activatedAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    status: 'active',
    branchId: null,
    deactivatedAt: null,
    ...clockIntegrityFields(clockIntegrity, now),
  });
  const cert = buildCertificate({ license, licenseId, deviceId, now });
  const { payload, signatureBase64Url } = signCertificate(cert, LICENSE_SIGNING_PRIVATE_KEY.value());
  await writeAuditLog({ type: 'activation_approved', businessId: license.businessId, licenseId, deviceId, meta: { ip } });
  return sendJson(res, 200, ok({ certificatePayload: payload, signature: signatureBase64Url, deviceSecret, serverTime: now.toISOString() }));
}), { secrets: [LICENSE_SIGNING_PRIVATE_KEY], maxInstances: PUBLIC_MAX_INSTANCES });

/**
 * Public, but requires the per-device secret issued at activation (not just
 * a guessable deviceId) - this is what an already-activated device calls
 * periodically to refresh its offline grace window and pick up a
 * suspend/revoke/renew that happened server-side since it last checked in.
 */
exports.revalidateDevice = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  if (!(await requireAppCheck(req, res))) return;
  const { deviceId, deviceSecret, clockIntegrity = null } = req.body || {};
  if (!deviceId || !deviceSecret) {
    return sendJson(res, 400, fail('invalid-argument', 'deviceId and deviceSecret are required'));
  }
  const deviceRef = db.collection('devices').doc(deviceId);
  const deviceSnap = await deviceRef.get();
  if (!deviceSnap.exists || sha256Hex(deviceSecret) !== deviceSnap.data().deviceSecretHash) {
    return sendJson(res, 401, fail('unauthenticated', 'Device credentials not recognized.'));
  }
  const device = deviceSnap.data();
  if (device.status !== 'active') {
    await writeAuditLog({ type: 'revalidation_rejected', businessId: device.businessId, licenseId: device.licenseId, deviceId, meta: { reason: 'device_deactivated' } });
    return sendJson(res, 403, fail('failed-precondition', 'This device has been deactivated.'));
  }
  const licenseSnap = await db.collection('licenses').doc(device.licenseId).get();
  if (!licenseSnap.exists) {
    return sendJson(res, 404, fail('not-found', 'License not found.'));
  }
  const license = licenseSnap.data();
  const now = new Date();
  const clockFields = clockIntegrityFields(clockIntegrity, now);
  await deviceRef.update({ lastSeenAt: now.toISOString(), ...clockFields });
  const cert = buildCertificate({ license, licenseId: device.licenseId, deviceId, now });
  const { payload, signatureBase64Url } = signCertificate(cert, LICENSE_SIGNING_PRIVATE_KEY.value());
  await writeAuditLog({ type: 'revalidation_succeeded', businessId: device.businessId, licenseId: device.licenseId, deviceId, meta: { status: cert.status } });
  if (clockFields.clockIntegritySeverity === 'high') {
    await writeAuditLog({ type: 'clock_tamper_suspected', businessId: device.businessId, licenseId: device.licenseId, deviceId, meta: clockFields });
  }
  return sendJson(res, 200, ok({ certificatePayload: payload, signature: signatureBase64Url, serverTime: now.toISOString() }));
}), { secrets: [LICENSE_SIGNING_PRIVATE_KEY], maxInstances: PUBLIC_MAX_INSTANCES });
