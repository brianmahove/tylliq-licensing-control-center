// A license's stored `status` is the admin's intent (active/suspended/
// revoked/expired); its *effective* status also accounts for expiresAt
// having passed, without needing a scheduled job to flip the stored value.
// Suspended/revoked always win over expiry - an admin's explicit action is
// never silently overridden by a clock check.
function effectiveStatus(license, nowMs) {
  if (license.status === "suspended" || license.status === "revoked") return license.status;
  if (license.expiresAt && new Date(license.expiresAt).getTime() <= nowMs) return "expired";
  return license.status;
}

module.exports = { effectiveStatus };
