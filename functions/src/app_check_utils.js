const { admin } = require('./firebase_admin');
const { fail, sendJson } = require('./response_utils');

// Verifies the caller is the real Flutter app (via Play Integrity/App
// Attest attestation), not a script hitting these public, otherwise-
// unauthenticated endpoints directly. Enforcement is OFF by default -
// flip ENFORCE_APP_CHECK=true (functions/.env or .env.<project-id>) only
// after: (1) the Flutter app has shipped with App Check wired in
// (lib/license/license_api_client.dart), and (2) Play Integrity is
// enrolled for the app in Play Console (App Check falls back to the debug
// provider until then, which real users' devices can't produce). Flipping
// this on before both are true locks every shop out of activation. See
// "Cost controls" in README.md.
const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === 'true';

/**
 * Call at the top of a public onRequest handler:
 *   if (!(await requireAppCheck(req, res))) return;
 * Writes the error response and returns false on failure. While
 * ENFORCE_APP_CHECK is unset, missing/invalid tokens are logged but the
 * request proceeds (fail-open), so this can be deployed ahead of the
 * client-side rollout without breaking activation.
 * @param {*} req
 * @param {*} res
 * @return {Promise<boolean>}
 */
async function requireAppCheck(req, res) {
  const token = req.get('X-Firebase-AppCheck');
  if (!token) {
    if (ENFORCE_APP_CHECK) {
      sendJson(res, 401, fail('unauthenticated', 'Missing App Check token.'));
      return false;
    }
    console.warn('App Check: missing token (not enforced yet)');
    return true;
  }
  try {
    await admin.appCheck().verifyToken(token);
    return true;
  } catch (err) {
    if (ENFORCE_APP_CHECK) {
      sendJson(res, 401, fail('unauthenticated', 'Invalid App Check token.'));
      return false;
    }
    console.warn('App Check: invalid token (not enforced yet):', err.message);
    return true;
  }
}

module.exports = { requireAppCheck };
