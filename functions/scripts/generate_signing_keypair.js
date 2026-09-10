// One-time setup. Generates the Ed25519 keypair that signs every license
// certificate. Run locally - NEVER on a machine that also builds/ships the
// Flutter app with the private half still lying around.
//
//   node scripts/generate_signing_keypair.js
//
// Then:
//   1. Paste the PUBLIC key into shopsync_pos/lib/license/license_crypto.dart
//      (replaces the placeholder constant there).
//   2. Store the PRIVATE key ONLY as a Firebase Functions secret:
//        firebase functions:secrets:set LICENSE_SIGNING_PRIVATE_KEY
//      (paste the full PEM, including the BEGIN/END lines, when prompted)
//   3. Do not commit the private key anywhere. Keep an offline backup
//      somewhere secure - losing it means every already-issued license
//      certificate can still be verified (verification only needs the
//      public key), but you can no longer sign new ones.

const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicDer = publicKey.export({ type: 'spki', format: 'der' });
const rawPublicKey = publicDer.subarray(publicDer.length - 32);
const publicBase64Url = rawPublicKey.toString('base64url');

console.log('=== Ed25519 license-signing keypair ===\n');
console.log('PUBLIC key (base64url, 32 raw bytes) - paste into Flutter\'s LicenseCrypto.publicKeyBase64:\n');
console.log(publicBase64Url);
console.log('\nPRIVATE key (PKCS8 PEM) - set as a Firebase secret, never commit:\n');
console.log(privatePem);
console.log('Set it with:\n  firebase functions:secrets:set LICENSE_SIGNING_PRIVATE_KEY\n');
