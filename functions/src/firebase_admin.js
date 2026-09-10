const admin = require("firebase-admin");

// Default init: picks up the deployed Function's service account in
// production, or GOOGLE_APPLICATION_CREDENTIALS / emulator config locally.
// No hardcoded project id, so the same code deploys to whichever Firebase
// project is targeted (see .firebaserc).
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

module.exports = { admin, db };
