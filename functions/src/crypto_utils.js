const crypto = require("crypto");

// Exact field order signed into every certificate. The Flutter client
// (lib/license/license_crypto.dart) builds the identical JSON string by
// hand from this same field list - do not reorder without updating both
// sides, and bump certVersion in activation.js if the *shape* ever changes.
const CERT_FIELD_ORDER = [
  "licenseId", "businessId", "deviceId", "planId",
  "issuedAt", "expiresAt", "maxDevices", "features",
  "status", "certVersion", "serverTime",
];

/**
 * Builds the exact byte sequence that gets signed/verified: a hand-rolled
 * minified JSON object with a fixed key order, so it never depends on a
 * particular JS engine's (or Dart's) object/map iteration-order guarantees.
 * @param {Object} cert certificate fields, keyed by CERT_FIELD_ORDER
 * @return {string} canonical JSON string
 */
function canonicalCertJson(cert) {
  const parts = CERT_FIELD_ORDER.map((key) => {
    const value = cert[key] === undefined ? null : cert[key];
    return `${JSON.stringify(key)}:${JSON.stringify(value)}`;
  });
  return `{${parts.join(",")}}`;
}

/**
 * Signs a certificate with the Ed25519 private key (PEM, PKCS8) held only
 * as a Functions secret. Never called with anything but that secret's value.
 * @param {Object} cert certificate fields
 * @param {string} privateKeyPem PKCS8 PEM from generate_signing_keypair.js
 * @return {{payload: string, signatureBase64Url: string}}
 */
function signCertificate(cert, privateKeyPem) {
  const payload = canonicalCertJson(cert);
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), privateKey);
  return { payload, signatureBase64Url: signature.toString("base64url") };
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

module.exports = { CERT_FIELD_ORDER, canonicalCertJson, signCertificate, randomToken, sha256Hex };
