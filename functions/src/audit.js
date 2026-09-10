const { onRequest } = require('./https_utils');
const { db } = require('./firebase_admin');
const { requireAdmin } = require('./admin_auth');
const { ok, fail, sendJson } = require('./response_utils');
const { withCors } = require('./cors_utils');

/**
 * Records one licensing event. `meta` must never contain a raw licenseKey
 * or deviceSecret - only opaque ids and small descriptive fields.
 * @param {Object} entry
 * @param {string} entry.type
 * @param {string|null} [entry.businessId]
 * @param {string|null} [entry.licenseId]
 * @param {string|null} [entry.deviceId]
 * @param {Object} [entry.meta]
 */
async function writeAuditLog({ type, businessId = null, licenseId = null, deviceId = null, meta = {} }) {
  await db.collection('auditLog').add({
    type,
    businessId,
    licenseId,
    deviceId,
    meta,
    at: new Date().toISOString(),
  });
}

// Exactly one of these may be combined with the mandatory orderBy(at desc) -
// see the matching composite indexes in firestore.indexes.json. "Activation
// Attempts" in the admin panel is just this filtered to type in
// [activation_approved, activation_rejected] client-side, rather than a
// second duplicate log.
exports.adminListAuditLog = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  if (!(await requireAdmin(req, res))) return;
  const { businessId = null, licenseId = null, deviceId = null, type = null, limit = 50 } = req.body || {};
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  let query = db.collection('auditLog');
  if (businessId) query = query.where('businessId', '==', businessId);
  else if (licenseId) query = query.where('licenseId', '==', licenseId);
  else if (deviceId) query = query.where('deviceId', '==', deviceId);
  else if (type) query = query.where('type', '==', type);
  query = query.orderBy('at', 'desc').limit(cappedLimit);
  const snap = await query.get();
  return sendJson(res, 200, ok({ events: snap.docs.map((d) => ({ id: d.id, ...d.data() })) }));
}));

module.exports.writeAuditLog = writeAuditLog;
