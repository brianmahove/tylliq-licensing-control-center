const { admin } = require("./firebase_admin");
const { fail, sendJson } = require("./response_utils");

// Roles are a Firebase Auth custom claim (`role`), granted out-of-band via
// scripts/set_admin_claim.js - there is no self-serve admin signup. This is
// deliberately a single string claim (not a boolean) so new roles can be
// added later without changing the auth mechanism, per the requirement that
// the architecture not be hardcoded to one "isAdmin" flag.
const ALL_ADMIN_ROLES = ["super_admin", "license_admin", "support_admin", "finance_admin", "read_only"];

/**
 * Verifies the request's `Authorization: Bearer <Firebase ID token>` and
 * that the signed-in user's `role` custom claim is one of `allowedRoles`.
 * Writes an error response and returns null on failure, so callers can just
 * `if (!(await requireRole(req, res, [...]))) return;`.
 * @param {*} req
 * @param {*} res
 * @param {string[]} [allowedRoles] defaults to "any authenticated admin role" (read access)
 * @return {Promise<import("firebase-admin/auth").DecodedIdToken|null>}
 */
async function requireRole(req, res, allowedRoles = ALL_ADMIN_ROLES) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) {
    sendJson(res, 401, fail("unauthenticated", "Missing bearer token."));
    return null;
  }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (err) {
    sendJson(res, 401, fail("unauthenticated", "Invalid or expired token."));
    return null;
  }
  const role = decoded.role;
  if (!role || !ALL_ADMIN_ROLES.includes(role)) {
    sendJson(res, 403, fail("permission-denied", "This account has no administrator role."));
    return null;
  }
  if (!allowedRoles.includes(role)) {
    sendJson(res, 403, fail("permission-denied", `This action requires one of: ${allowedRoles.join(", ")}.`));
    return null;
  }
  return decoded;
}

/** Convenience: any authenticated admin role at all (read access). */
function requireAdmin(req, res) {
  return requireRole(req, res, ALL_ADMIN_ROLES);
}

module.exports = { requireRole, requireAdmin, ALL_ADMIN_ROLES };
