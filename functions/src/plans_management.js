const { onRequest } = require('./https_utils');
const { db } = require('./firebase_admin');
const { requireRole, requireAdmin } = require('./admin_auth');
const { ok, fail, sendJson } = require('./response_utils');
const { withCors } = require('./cors_utils');
const { writeAuditLog } = require('./audit');

// Plans are data, not code - the Flutter app never hardcodes "Professional
// = 3 devices"; a license references a planId, and the plan's terms live
// here so new plans/products can be added without an app release.
const WRITE_ROLES = ['super_admin', 'license_admin'];

exports.adminCreatePlan = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const admin_ = await requireRole(req, res, WRITE_ROLES);
  if (!admin_) return;
  const { planId, name, priceCents = 0, currency = 'USD', billingPeriod = 'monthly', maxDevices, features = [], productId = null } = req.body || {};
  if (!planId || !name || !Number.isInteger(maxDevices) || maxDevices < 1) {
    return sendJson(res, 400, fail('invalid-argument', 'planId, name, and a positive integer maxDevices are required'));
  }
  const ref = db.collection('plans').doc(planId);
  if ((await ref.get()).exists) return sendJson(res, 409, fail('already-exists', 'A plan with this id already exists.'));
  const now = new Date().toISOString();
  await ref.set({ name, priceCents, currency, billingPeriod, maxDevices, features, productId, status: 'active', createdAt: now, updatedAt: now });
  await writeAuditLog({ type: 'plan_created', meta: { planId, by: admin_.uid } });
  return sendJson(res, 200, ok({ planId }));
}));

exports.adminUpdatePlan = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const admin_ = await requireRole(req, res, WRITE_ROLES);
  if (!admin_) return;
  const { planId, ...patch } = req.body || {};
  if (!planId) return sendJson(res, 400, fail('invalid-argument', 'planId is required'));
  const ref = db.collection('plans').doc(planId);
  if (!(await ref.get()).exists) return sendJson(res, 404, fail('not-found', 'Plan not found'));
  delete patch.createdAt;
  await ref.update({ ...patch, updatedAt: new Date().toISOString() });
  await writeAuditLog({ type: 'plan_updated', meta: { planId, patch, by: admin_.uid } });
  return sendJson(res, 200, ok({ planId }));
}));

exports.adminListPlans = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  if (!(await requireAdmin(req, res))) return;
  const snap = await db.collection('plans').orderBy('createdAt', 'asc').get();
  return sendJson(res, 200, ok({ plans: snap.docs.map((d) => ({ planId: d.id, ...d.data() })) }));
}));
