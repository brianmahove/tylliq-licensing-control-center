const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { db } = require('./firebase_admin');
const { ok, fail, sendJson } = require('./response_utils');
const { withCors } = require('./cors_utils');
const { writeAuditLog } = require('./audit');
const { signCertificate, randomToken, sha256Hex } = require('./crypto_utils');
const { effectiveStatus } = require('./license_status');

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

async function findLicenseByKey(licenseKey) {
  const hash = sha256Hex(licenseKey);
  const snap = await db.collection('licenses').where('licenseKeyHash', '==', hash).limit(1).get();
  if (snap.empty) return null;
  return { licenseId: snap.docs[0].id, license: snap.docs[0].data() };
}

/**
 * Public, unauthenticated. The licenseKey itself is the credential - there
 * is no client-supplied businessId anywhere in this request, so a customer
 * editing local data can't point their device at someone else's business
 * (see the "Why a licenseKey is the credential" note in
 * docs/LICENSING_ADMIN.md).
 */
exports.activateDevice = onRequest({ secrets: [LICENSE_SIGNING_PRIVATE_KEY] }, withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const { licenseKey, deviceId, platform, appVersion, deviceLabel = null } = req.body || {};
  if (!licenseKey || !deviceId || !platform || !appVersion) {
    return sendJson(res, 400, fail('invalid-argument', 'licenseKey, deviceId, platform, and appVersion are required'));
  }
  const ip = req.ip || req.headers['x-forwarded-for'] || null;

  const found = await findLicenseByKey(licenseKey);
  if (!found) {
    await writeAuditLog({ type: 'activation_rejected', deviceId, meta: { reason: 'invalid_license_key', ip } });
    return sendJson(res, 404, fail('not-found', 'License key not recognized.'));
  }
  const { licenseId, license } = found;
  const now = new Date();
  const status = effectiveStatus(license, now.getTime());
  if (status !== 'active') {
    await writeAuditLog({ type: 'activation_rejected', businessId: license.businessId, licenseId, deviceId, meta: { reason: `license_${status}`, ip } });
    return sendJson(res, 403, fail('failed-precondition', `This license is ${status}.`));
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
    await deviceRef.update({
      status: 'active',
      platform, appVersion, deviceLabel,
      lastSeenAt: now.toISOString(),
      deviceSecretHash: sha256Hex(deviceSecret),
      deactivatedAt: null,
    });
    const cert = buildCertificate({ license, licenseId, deviceId, now });
    const { payload, signatureBase64Url } = signCertificate(cert, LICENSE_SIGNING_PRIVATE_KEY.value());
    await writeAuditLog({ type: 'activation_approved', businessId: license.businessId, licenseId, deviceId, meta: { reactivated: true, ip } });
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
  });
  const cert = buildCertificate({ license, licenseId, deviceId, now });
  const { payload, signatureBase64Url } = signCertificate(cert, LICENSE_SIGNING_PRIVATE_KEY.value());
  await writeAuditLog({ type: 'activation_approved', businessId: license.businessId, licenseId, deviceId, meta: { ip } });
  return sendJson(res, 200, ok({ certificatePayload: payload, signature: signatureBase64Url, deviceSecret, serverTime: now.toISOString() }));
}));

/**
 * Public, but requires the per-device secret issued at activation (not just
 * a guessable deviceId) - this is what an already-activated device calls
 * periodically to refresh its offline grace window and pick up a
 * suspend/revoke/renew that happened server-side since it last checked in.
 */
exports.revalidateDevice = onRequest({ secrets: [LICENSE_SIGNING_PRIVATE_KEY] }, withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const { deviceId, deviceSecret } = req.body || {};
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
  await deviceRef.update({ lastSeenAt: now.toISOString() });
  const cert = buildCertificate({ license, licenseId: device.licenseId, deviceId, now });
  const { payload, signatureBase64Url } = signCertificate(cert, LICENSE_SIGNING_PRIVATE_KEY.value());
  await writeAuditLog({ type: 'revalidation_succeeded', businessId: device.businessId, licenseId: device.licenseId, deviceId, meta: { status: cert.status } });
  return sendJson(res, 200, ok({ certificatePayload: payload, signature: signatureBase64Url, serverTime: now.toISOString() }));
}));
