const { onRequest } = require('firebase-functions/v2/https');
const { db } = require('./firebase_admin');
const { requireRole, requireAdmin } = require('./admin_auth');
const { ok, fail, sendJson } = require('./response_utils');
const { withCors } = require('./cors_utils');
const { writeAuditLog } = require('./audit');

// A small registry of known feature keys (POS, inventory, reports, ...) so
// the admin UI offers a picklist instead of free text, and every product's
// entitlement checks share one vocabulary instead of hardcoding strings.
const WRITE_ROLES = ['super_admin', 'license_admin'];

exports.adminCreateFeature = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  const admin_ = await requireRole(req, res, WRITE_ROLES);
  if (!admin_) return;
  const { key, label, description = null, productId = null } = req.body || {};
  if (!key || !label || !/^[a-z0-9_]+$/.test(key)) {
    return sendJson(res, 400, fail('invalid-argument', 'key (lowercase_snake_case) and label are required'));
  }
  const ref = db.collection('features').doc(key);
  if ((await ref.get()).exists) return sendJson(res, 409, fail('already-exists', 'A feature with this key already exists.'));
  const now = new Date().toISOString();
  await ref.set({ label, description, productId, createdAt: now, updatedAt: now });
  await writeAuditLog({ type: 'feature_created', meta: { key, by: admin_.uid } });
  return sendJson(res, 200, ok({ key }));
}));

exports.adminListFeatures = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  if (!(await requireAdmin(req, res))) return;
  const snap = await db.collection('features').orderBy('createdAt', 'asc').get();
  return sendJson(res, 200, ok({ features: snap.docs.map((d) => ({ key: d.id, ...d.data() })) }));
}));
