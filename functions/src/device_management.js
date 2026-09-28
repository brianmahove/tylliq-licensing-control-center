const { onRequest } = require('./https_utils');
const { db } = require('./firebase_admin');
const { requireRole, requireAdmin } = require('./admin_auth');
const { ok, fail, sendJson } = require('./response_utils');
const { withCors } = require('./cors_utils');
const { writeAuditLog } = require('./audit');
const { redactDevice } = require('./redact');

const WRITE_ROLES = ['super_admin', 'license_admin', 'support_admin'];

exports.adminListDevices = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  if (!(await requireAdmin(req, res))) return;
  const { licenseId = null, businessId = null, limit = 100 } = req.body || {};
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
  let query = db.collection('devices');
  if (licenseId) query = query.where('licenseId', '==', licenseId);
  else if (businessId) query = query.where('businessId', '==', businessId);
  const snap = await query.limit(cappedLimit).get();
  const devices = snap.docs.map((d) => redactDevice(d.id, d.data()));
  return sendJson(res, 200, ok({ devices }));
}));

exports.adminDeactivateDevice = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const admin_ = await requireRole(req, res, WRITE_ROLES);
  if (!admin_) return;
  const { deviceId } = req.body || {};
  if (!deviceId) return sendJson(res, 400, fail('invalid-argument', 'deviceId is required'));
  const ref = db.collection('devices').doc(deviceId);
  const snap = await ref.get();
  if (!snap.exists) return sendJson(res, 404, fail('not-found', 'Device not found.'));
  // This is the only thing that actually frees the slot - a device the
  // client just deletes locally never touches this, so its slot stays
  // occupied server-side and activationDevice keeps rejecting a 4th device.
  await ref.update({ status: 'deactivated', deactivatedAt: new Date().toISOString() });
  await writeAuditLog({ type: 'device_deactivated', businessId: snap.data().businessId, licenseId: snap.data().licenseId, deviceId, meta: { by: `admin:${admin_.uid}` } });
  return sendJson(res, 200, ok({ deviceId, status: 'deactivated' }));
}));

const MAX_DEVICE_LABEL_LENGTH = 60;

exports.adminRenameDevice = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const admin_ = await requireRole(req, res, WRITE_ROLES);
  if (!admin_) return;
  const { deviceId, deviceLabel } = req.body || {};
  if (!deviceId) return sendJson(res, 400, fail('invalid-argument', 'deviceId is required'));
  if (deviceLabel != null && typeof deviceLabel !== 'string') {
    return sendJson(res, 400, fail('invalid-argument', 'deviceLabel must be a string'));
  }
  // A blank name clears the label back to "no name" rather than storing ''.
  const label = (deviceLabel || '').trim() || null;
  if (label && label.length > MAX_DEVICE_LABEL_LENGTH) {
    return sendJson(res, 400, fail('invalid-argument', `deviceLabel must be at most ${MAX_DEVICE_LABEL_LENGTH} characters`));
  }
  const ref = db.collection('devices').doc(deviceId);
  const snap = await ref.get();
  if (!snap.exists) return sendJson(res, 404, fail('not-found', 'Device not found.'));
  await ref.update({ deviceLabel: label });
  await writeAuditLog({ type: 'device_renamed', businessId: snap.data().businessId, licenseId: snap.data().licenseId, deviceId, meta: { by: `admin:${admin_.uid}` } });
  return sendJson(res, 200, ok({ deviceId, deviceLabel: label }));
}));
