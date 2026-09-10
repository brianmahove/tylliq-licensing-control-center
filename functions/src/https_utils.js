const { onRequest: onRequestV2 } = require('firebase-functions/v2/https');

// Caps how many concurrent instances any one function can scale to - a hard
// ceiling on worst-case Cloud Functions cost from a bug, a retry loop, or
// abuse, independent of the App Check / rate-limiting defenses upstream of
// it. Public endpoints (activation, self-service) get a higher ceiling
// since their legitimate traffic scales with the number of shops; admin
// endpoints are used by a handful of staff at a time. See "Cost controls"
// in README.md.
const DEFAULT_MAX_INSTANCES = 10;
const PUBLIC_MAX_INSTANCES = 20;

/**
 * Drop-in replacement for firebase-functions/v2/https's onRequest that
 * applies a maxInstances ceiling by default, so call sites don't each have
 * to remember to set one.
 * @param {Function} handler (req, res) => void
 * @param {Object} [opts] extra onRequest options (e.g. secrets, maxInstances override)
 * @return {Function}
 */
function onRequest(handler, opts = {}) {
  return onRequestV2({ maxInstances: DEFAULT_MAX_INSTANCES, ...opts }, handler);
}

module.exports = { onRequest, PUBLIC_MAX_INSTANCES };
