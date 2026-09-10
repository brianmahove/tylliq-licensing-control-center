const { db } = require('./firebase_admin');

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ACTIVATION_MAX_ATTEMPTS_PER_WINDOW = 20;

// listMyDevices/deactivateMyDevice don't need brute-force protection - the
// licenseKey is a 160-bit token, not realistically guessable - but they're
// still public, unauthenticated, billed Cloud Functions invocations, so an
// IP hammering them for cost-based abuse should still get capped. Looser
// than activation's since these are legitimate self-service actions a busy
// front desk might call repeatedly.
const SELF_SERVICE_MAX_ATTEMPTS_PER_WINDOW = 60;

/**
 * @param {string} bucket logical name for what's being limited (e.g. "activate", "self_service")
 * @param {string|null} ip caller's IP, or null if unavailable
 * @param {number} maxAttempts attempts allowed per window before rejecting
 * @return {Promise<boolean>} false if this IP should be rejected with 429
 */
async function checkIpRateLimit(bucket, ip, maxAttempts) {
  // No identifier to key on - fail open rather than accidentally rate-limit
  // every caller behind an unknown proxy under one bucket.
  if (!ip) return true;

  const ref = db.collection('rateLimits').doc(`${bucket}_${ip}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.exists ? snap.data() : null;
    if (!data || now - data.windowStart > WINDOW_MS) {
      tx.set(ref, { windowStart: now, count: 1 });
      return true;
    }
    if (data.count >= maxAttempts) return false;
    tx.update(ref, { count: data.count + 1 });
    return true;
  });
}

function checkActivationRateLimit(ip) {
  return checkIpRateLimit('activate', ip, ACTIVATION_MAX_ATTEMPTS_PER_WINDOW);
}

function checkSelfServiceRateLimit(ip) {
  return checkIpRateLimit('self_service', ip, SELF_SERVICE_MAX_ATTEMPTS_PER_WINDOW);
}

module.exports = { checkActivationRateLimit, checkSelfServiceRateLimit };
