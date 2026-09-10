const { onRequest } = require('./https_utils');
const { db } = require('./firebase_admin');
const { requireRole, requireAdmin } = require('./admin_auth');
const { ok, fail, sendJson } = require('./response_utils');
const { withCors } = require('./cors_utils');
const { writeAuditLog } = require('./audit');
const { redactLicense, redactDevice } = require('./redact');

const WRITE_ROLES = ['super_admin', 'license_admin'];
const VALID_BUSINESS_STATUSES = ['active', 'suspended'];

exports.adminCreateBusiness = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const admin_ = await requireRole(req, res, WRITE_ROLES);
  if (!admin_) return;
  const { name, contactEmail = null, country = null, notes = null } = req.body || {};
  if (!name || typeof name !== 'string') {
    return sendJson(res, 400, fail('invalid-argument', 'name is required'));
  }
  const ref = db.collection('businesses').doc();
  const now = new Date().toISOString();
  await ref.set({ name, contactEmail, country, notes, status: 'active', createdAt: now, updatedAt: now });
  await writeAuditLog({ type: 'business_created', businessId: ref.id, meta: { name, by: admin_.uid } });
  return sendJson(res, 200, ok({ businessId: ref.id }));
}));

exports.adminSetBusinessStatus = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const admin_ = await requireRole(req, res, WRITE_ROLES);
  if (!admin_) return;
  const { businessId, status } = req.body || {};
  if (!businessId || !VALID_BUSINESS_STATUSES.includes(status)) {
    return sendJson(res, 400, fail('invalid-argument', `status must be one of ${VALID_BUSINESS_STATUSES.join(', ')}`));
  }
  const ref = db.collection('businesses').doc(businessId);
  if (!(await ref.get()).exists) return sendJson(res, 404, fail('not-found', 'Business not found'));
  await ref.update({ status, updatedAt: new Date().toISOString() });
  await writeAuditLog({ type: `business_${status}`, businessId, meta: { by: admin_.uid } });
  return sendJson(res, 200, ok({ businessId, status }));
}));

exports.adminGetBusiness = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  if (!(await requireAdmin(req, res))) return;
  const { businessId } = req.body || {};
  if (!businessId) return sendJson(res, 400, fail('invalid-argument', 'businessId is required'));
  const snap = await db.collection('businesses').doc(businessId).get();
  if (!snap.exists) return sendJson(res, 404, fail('not-found', 'Business not found'));
  const [licensesSnap, devicesSnap] = await Promise.all([
    db.collection('licenses').where('businessId', '==', businessId).get(),
    db.collection('devices').where('businessId', '==', businessId).get(),
  ]);
  const licenses = licensesSnap.docs.map((d) => redactLicense(d.id, d.data()));
  const devices = devicesSnap.docs.map((d) => redactDevice(d.id, d.data()));
  return sendJson(res, 200, ok({ businessId, ...snap.data(), licenses, devices }));
}));

exports.adminListBusinesses = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  if (!(await requireAdmin(req, res))) return;
  const { limit = 50, cursor = null } = req.body || {};
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  let query = db.collection('businesses').orderBy('createdAt', 'desc').limit(cappedLimit);
  if (cursor) {
    const cursorSnap = await db.collection('businesses').doc(cursor).get();
    if (cursorSnap.exists) query = query.startAfter(cursorSnap);
  }
  const snap = await query.get();
  const businesses = snap.docs.map((d) => ({ businessId: d.id, ...d.data() }));
  const nextCursor = snap.docs.length === cappedLimit ? snap.docs[snap.docs.length - 1].id : null;
  return sendJson(res, 200, ok({ businesses, nextCursor }));
}));
