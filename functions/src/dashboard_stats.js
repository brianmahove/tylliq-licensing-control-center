const { onRequest } = require('./https_utils');
const { db } = require('./firebase_admin');
const { requireAdmin } = require('./admin_auth');
const { ok, fail, sendJson } = require('./response_utils');
const { withCors } = require('./cors_utils');

exports.adminGetDashboardStats = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  if (!(await requireAdmin(req, res))) return;

  const now = Date.now();
  const soon = now + 7 * 86400000;

  const [
    totalBusinesses, activeBusinesses, suspendedBusinesses,
    activeLicenses, suspendedLicenses, revokedLicenses,
    totalDevices, activeDevices,
    recentPayments, recentActivity, failedActivations,
  ] = await Promise.all([
    db.collection('businesses').count().get(),
    db.collection('businesses').where('status', '==', 'active').count().get(),
    db.collection('businesses').where('status', '==', 'suspended').count().get(),
    db.collection('licenses').where('status', '==', 'active').count().get(),
    db.collection('licenses').where('status', '==', 'suspended').count().get(),
    db.collection('licenses').where('status', '==', 'revoked').count().get(),
    db.collection('devices').count().get(),
    db.collection('devices').where('status', '==', 'active').count().get(),
    db.collection('payments').orderBy('createdAt', 'desc').limit(5).get(),
    db.collection('auditLog').orderBy('at', 'desc').limit(10).get(),
    db.collection('auditLog').where('type', '==', 'activation_rejected').orderBy('at', 'desc').limit(20).get(),
  ]);

  // count() aggregation can't also filter on expiresAt, so "expiring soon"
  // needs the actual field - only ever reads the (small) set of licenses
  // that are currently active, not the whole collection.
  const activeLicenseDocs = await db.collection('licenses').where('status', '==', 'active').select('expiresAt').get();
  let expiringSoon = 0;
  let expiredButNotFlagged = 0;
  activeLicenseDocs.forEach((doc) => {
    const expiresAt = doc.data().expiresAt;
    if (!expiresAt) return;
    const ms = new Date(expiresAt).getTime();
    if (ms <= now) expiredButNotFlagged++;
    else if (ms <= soon) expiringSoon++;
  });

  return sendJson(res, 200, ok({
    businesses: { total: totalBusinesses.data().count, active: activeBusinesses.data().count, suspended: suspendedBusinesses.data().count },
    licenses: {
      active: activeLicenses.data().count,
      suspended: suspendedLicenses.data().count,
      revoked: revokedLicenses.data().count,
      expiringSoon,
      expired: expiredButNotFlagged,
    },
    devices: { total: totalDevices.data().count, active: activeDevices.data().count },
    recentPayments: recentPayments.docs.map((d) => ({ paymentId: d.id, ...d.data() })),
    recentActivity: recentActivity.docs.map((d) => ({ id: d.id, ...d.data() })),
    failedActivationsLast20: failedActivations.docs.map((d) => ({ id: d.id, ...d.data() })),
  }));
}));
