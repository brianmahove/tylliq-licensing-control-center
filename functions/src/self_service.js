const { onRequest } = require('firebase-functions/v2/https');
const { db } = require('./firebase_admin');
const { ok, fail, sendJson } = require('./response_utils');
const { withCors } = require('./cors_utils');
const { writeAuditLog } = require('./audit');
const { sha256Hex } = require('./crypto_utils');
const { redactDevice } = require('./redact');

// Lets a business owner manage their own devices (e.g. to free a slot for a
// replacement computer) by re-entering the licenseKey each time, rather
// than the app persisting that key locally forever - the key can activate
// and deactivate devices for the whole business, so it's deliberately not
// a stored, silently-reusable credential on any one device (see section 8
// / section 15 of the licensing spec).
async function licenseFromKey(licenseKey) {
  const hash = sha256Hex(licenseKey);
  const snap = await db.collection('licenses').where('licenseKeyHash', '==', hash).limit(1).get();
  if (snap.empty) return null;
  return { licenseId: snap.docs[0].id, license: snap.docs[0].data() };
}

exports.listMyDevices = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const { licenseKey } = req.body || {};
  if (!licenseKey) return sendJson(res, 400, fail('invalid-argument', 'licenseKey is required'));
  const found = await licenseFromKey(licenseKey);
  if (!found) return sendJson(res, 404, fail('not-found', 'License key not recognized.'));
  const devicesSnap = await db.collection('devices').where('licenseId', '==', found.licenseId).get();
  const devices = devicesSnap.docs.map((d) => redactDevice(d.id, d.data()));
  return sendJson(res, 200, ok({ licenseId: found.licenseId, maxDevices: found.license.maxDevices, devices }));
}));

exports.deactivateMyDevice = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const { licenseKey, deviceId } = req.body || {};
  if (!licenseKey || !deviceId) return sendJson(res, 400, fail('invalid-argument', 'licenseKey and deviceId are required'));
  const found = await licenseFromKey(licenseKey);
  if (!found) return sendJson(res, 404, fail('not-found', 'License key not recognized.'));
  const deviceRef = db.collection('devices').doc(deviceId);
  const deviceSnap = await deviceRef.get();
  if (!deviceSnap.exists || deviceSnap.data().licenseId !== found.licenseId) {
    return sendJson(res, 404, fail('not-found', 'Device not found on this license.'));
  }
  await deviceRef.update({ status: 'deactivated', deactivatedAt: new Date().toISOString() });
  await writeAuditLog({ type: 'device_deactivated', businessId: found.license.businessId, licenseId: found.licenseId, deviceId, meta: { by: 'self_service' } });
  return sendJson(res, 200, ok({ deviceId, status: 'deactivated' }));
}));
