const { onRequest } = require("firebase-functions/v2/https");
const { db } = require("./firebase_admin");
const { requireRole, requireAdmin } = require("./admin_auth");
const { ok, fail, sendJson } = require("./response_utils");
const { withCors } = require("./cors_utils");
const { writeAuditLog } = require("./audit");
const { randomToken, sha256Hex } = require("./crypto_utils");
const { redactLicense } = require("./redact");

const VALID_STATUSES = ["active", "suspended", "revoked", "expired"];
const WRITE_ROLES = ["super_admin", "license_admin"];

function formatLicenseKey(raw) {
  return `LIC-${raw}`;
}

exports.adminCreateLicense = onRequest(withCors(async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, fail("invalid-argument", "POST required"));
  const admin_ = await requireRole(req, res, WRITE_ROLES);
  if (!admin_) return;
  const { businessId, planId, maxDevices, features = [], expiresAt = null, startDate = null } = req.body || {};
  if (!businessId || !planId || !Number.isInteger(maxDevices) || maxDevices < 1) {
    return sendJson(res, 400, fail("invalid-argument", "businessId, planId, and a positive integer maxDevices are required"));
  }
  const businessSnap = await db.collection("businesses").doc(businessId).get();
  if (!businessSnap.exists) return sendJson(res, 404, fail("not-found", "Business not found"));

  // Shown once to the caller (like an API key) and stored only as a hash -
  // this is the credential that ties every activation request back to
  // exactly this business, so there is no client-editable businessId field
  // anywhere in the activation flow (see docs/LICENSING_ADMIN.md).
  const licenseKey = formatLicenseKey(randomToken(20));
  const licenseKeyHash = sha256Hex(licenseKey);
  const ref = db.collection("licenses").doc();
  const now = new Date();
  await ref.set({
    businessId,
    planId,
    status: "active",
    maxDevices,
    features: Array.isArray(features) ? features : [],
    licenseKeyHash,
    issuedAt: startDate ? new Date(startDate).toISOString() : now.toISOString(),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  await writeAuditLog({ type: "license_created", businessId, licenseId: ref.id, meta: { planId, maxDevices, by: admin_.uid } });
  return sendJson(res, 200, ok({ licenseId: ref.id, licenseKey }));
}));

exports.adminUpdateLicense = onRequest(withCors(async (req, res) => {
  // Covers renew / extend expiry / change plan / change device limit /
  // enable-disable features in one endpoint - they're all "patch this
  // license doc" operations sharing the same validation and audit shape.
  if (req.method !== "POST") return sendJson(res, 405, fail("invalid-argument", "POST required"));
  const admin_ = await requireRole(req, res, WRITE_ROLES);
  if (!admin_) return;
  const { licenseId, expiresAt, extendDays, planId, maxDevices, features } = req.body || {};
  if (!licenseId) return sendJson(res, 400, fail("invalid-argument", "licenseId is required"));
  const ref = db.collection("licenses").doc(licenseId);
  const snap = await ref.get();
  if (!snap.exists) return sendJson(res, 404, fail("not-found", "License not found"));
  const current = snap.data();

  const updates = { updatedAt: new Date().toISOString(), version: (current.version || 1) + 1 };
  if (extendDays !== undefined) {
    const base = current.expiresAt ? new Date(current.expiresAt).getTime() : Date.now();
    updates.expiresAt = new Date(base + Number(extendDays) * 86400000).toISOString();
  } else if (expiresAt !== undefined) {
    updates.expiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;
  }
  if (planId) updates.planId = planId;
  if (Number.isInteger(maxDevices) && maxDevices >= 1) updates.maxDevices = maxDevices;
  if (Array.isArray(features)) updates.features = features;
  const newExpiryMs = updates.expiresAt === undefined ? (current.expiresAt ? new Date(current.expiresAt).getTime() : null) : (updates.expiresAt ? new Date(updates.expiresAt).getTime() : null);
  if (current.status === "expired" && (newExpiryMs === null || newExpiryMs > Date.now())) {
    updates.status = "active";
  }

  await ref.update(updates);
  await writeAuditLog({ type: "license_updated", businessId: current.businessId, licenseId, meta: { ...updates, by: admin_.uid } });
  return sendJson(res, 200, ok({ licenseId }));
}));

exports.adminSetLicenseStatus = onRequest(withCors(async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, fail("invalid-argument", "POST required"));
  const admin_ = await requireRole(req, res, WRITE_ROLES);
  if (!admin_) return;
  const { licenseId, status } = req.body || {};
  if (!licenseId || !VALID_STATUSES.includes(status)) {
    return sendJson(res, 400, fail("invalid-argument", `status must be one of ${VALID_STATUSES.join(", ")}`));
  }
  const ref = db.collection("licenses").doc(licenseId);
  const snap = await ref.get();
  if (!snap.exists) return sendJson(res, 404, fail("not-found", "License not found"));
  await ref.update({ status, updatedAt: new Date().toISOString(), version: (snap.data().version || 1) + 1 });
  await writeAuditLog({ type: `license_${status}`, businessId: snap.data().businessId, licenseId, meta: { by: admin_.uid } });
  return sendJson(res, 200, ok({ licenseId, status }));
}));

exports.adminGetLicense = onRequest(withCors(async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, fail("invalid-argument", "POST required"));
  if (!(await requireAdmin(req, res))) return;
  const { licenseId } = req.body || {};
  if (!licenseId) return sendJson(res, 400, fail("invalid-argument", "licenseId is required"));
  const snap = await db.collection("licenses").doc(licenseId).get();
  if (!snap.exists) return sendJson(res, 404, fail("not-found", "License not found"));
  const activeCount = await db.collection("devices")
      .where("licenseId", "==", licenseId)
      .where("status", "==", "active")
      .count().get();
  return sendJson(res, 200, ok({ ...redactLicense(licenseId, snap.data()), activeDeviceCount: activeCount.data().count }));
}));

exports.adminListLicenses = onRequest(withCors(async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, fail("invalid-argument", "POST required"));
  if (!(await requireAdmin(req, res))) return;
  const { status = null, limit = 50, cursor = null } = req.body || {};
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  let query = status ? db.collection("licenses").where("status", "==", status) : db.collection("licenses");
  query = query.orderBy("createdAt", "desc").limit(cappedLimit);
  if (cursor) {
    const cursorSnap = await db.collection("licenses").doc(cursor).get();
    if (cursorSnap.exists) query = query.startAfter(cursorSnap);
  }
  const snap = await query.get();
  const licenses = snap.docs.map((d) => redactLicense(d.id, d.data()));
  const nextCursor = snap.docs.length === cappedLimit ? snap.docs[snap.docs.length - 1].id : null;
  return sendJson(res, 200, ok({ licenses, nextCursor }));
}));
