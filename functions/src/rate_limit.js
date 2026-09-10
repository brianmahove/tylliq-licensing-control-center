const { db } = require('./firebase_admin');

// Guards activateDevice specifically: licenseKey is the credential (see the
// "Why a licenseKey is the credential" note in activation.js), and it's the
// one thing here an attacker can brute-force guess by IP without already
// holding a valid secret - revalidateDevice's deviceSecret is a random
// 32-byte token, not realistically guessable, so it doesn't need this.
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_ATTEMPTS_PER_WINDOW = 20;

/**
 * @param {string|null} ip caller's IP, or null if unavailable
 * @return {Promise<boolean>} false if this IP should be rejected with 429
 */
async function checkActivationRateLimit(ip) {
  // No identifier to key on - fail open rather than accidentally rate-limit
  // every caller behind an unknown proxy under one bucket.
  if (!ip) return true;

  const ref = db.collection('rateLimits').doc(`activate_${ip}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.exists ? snap.data() : null;
    if (!data || now - data.windowStart > WINDOW_MS) {
      tx.set(ref, { windowStart: now, count: 1 });
      return true;
    }
    if (data.count >= MAX_ATTEMPTS_PER_WINDOW) return false;
    tx.update(ref, { count: data.count + 1 });
    return true;
  });
}

module.exports = { checkActivationRateLimit };
