const { onRequest } = require('./https_utils');
const { db } = require('./firebase_admin');
const { requireRole, requireAdmin } = require('./admin_auth');
const { ok, fail, sendJson } = require('./response_utils');
const { withCors } = require('./cors_utils');
const { writeAuditLog } = require('./audit');

// Payments are recorded manually today (EcoCash / bank transfer / WhatsApp
// confirmation). Recording a payment deliberately does NOT touch license
// status itself - an admin confirms the payment, then separately
// creates/renews the license via license_management.js. Keeping "money
// changed hands" and "license terms changed" as two auditable steps (rather
// than one endpoint doing both silently) is what lets an automated payment
// provider slot in later without redesigning the licensing side.
const VALID_STATUSES = ['pending', 'confirmed', 'rejected', 'refunded'];
const WRITE_ROLES = ['super_admin', 'finance_admin'];

exports.adminRecordPayment = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const admin_ = await requireRole(req, res, WRITE_ROLES);
  if (!admin_) return;
  const { businessId, licenseId = null, amountCents, currency = 'USD', method, reference = null, notes = null } = req.body || {};
  if (!businessId || !Number.isInteger(amountCents) || !method) {
    return sendJson(res, 400, fail('invalid-argument', 'businessId, amountCents, and method are required'));
  }
  const ref = db.collection('payments').doc();
  const now = new Date().toISOString();
  await ref.set({
    businessId, licenseId, amountCents, currency, method, reference, notes,
    status: 'pending', createdAt: now, updatedAt: now, confirmedBy: null,
  });
  await writeAuditLog({ type: 'payment_recorded', businessId, licenseId, meta: { paymentId: ref.id, amountCents, method, by: admin_.uid } });
  return sendJson(res, 200, ok({ paymentId: ref.id }));
}));

exports.adminSetPaymentStatus = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const admin_ = await requireRole(req, res, WRITE_ROLES);
  if (!admin_) return;
  const { paymentId, status } = req.body || {};
  if (!paymentId || !VALID_STATUSES.includes(status)) {
    return sendJson(res, 400, fail('invalid-argument', `status must be one of ${VALID_STATUSES.join(', ')}`));
  }
  const ref = db.collection('payments').doc(paymentId);
  const snap = await ref.get();
  if (!snap.exists) return sendJson(res, 404, fail('not-found', 'Payment not found'));
  await ref.update({
    status,
    updatedAt: new Date().toISOString(),
    confirmedBy: status === 'confirmed' ? admin_.uid : (snap.data().confirmedBy || null),
  });
  await writeAuditLog({ type: 'payment_status_changed', businessId: snap.data().businessId, licenseId: snap.data().licenseId, meta: { paymentId, status, by: admin_.uid } });
  return sendJson(res, 200, ok({ paymentId, status }));
}));

exports.adminListPayments = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  if (!(await requireAdmin(req, res))) return;
  const { businessId = null, limit = 50, cursor = null } = req.body || {};
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  let query = businessId ? db.collection('payments').where('businessId', '==', businessId) : db.collection('payments');
  query = query.orderBy('createdAt', 'desc').limit(cappedLimit);
  if (cursor) {
    const cursorSnap = await db.collection('payments').doc(cursor).get();
    if (cursorSnap.exists) query = query.startAfter(cursorSnap);
  }
  const snap = await query.get();
  const payments = snap.docs.map((d) => ({ paymentId: d.id, ...d.data() }));
  const nextCursor = snap.docs.length === cappedLimit ? snap.docs[snap.docs.length - 1].id : null;
  return sendJson(res, 200, ok({ payments, nextCursor }));
}));
