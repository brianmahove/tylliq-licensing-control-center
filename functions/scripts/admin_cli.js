#!/usr/bin/env node
// Developer/support CLI for the ShopSync licensing backend. Talks straight
// to Firestore via the Admin SDK (it's already a trusted, privileged
// context), so it works without the admin dashboard or a signed-in Firebase
// Auth session - useful for day-to-day license issuing before the Next.js
// panel exists, or from a terminal instead of a browser.
//
// Requires Google Application Default Credentials for the target project:
//   gcloud auth application-default login
// or
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json
//
// Usage:
//   node scripts/admin_cli.js create-business --name "ABC Hardware" --email owner@abc.com
//   node scripts/admin_cli.js create-plan --plan-id professional --name Professional --max-devices 3
//   node scripts/admin_cli.js create-license --business-id <id> --plan professional --max-devices 3 --days 365
//   node scripts/admin_cli.js create-license --business-id <id> --plan professional --max-devices 3 --perpetual
//   node scripts/admin_cli.js renew-license --license-id <id> --days 365
//   node scripts/admin_cli.js set-status --license-id <id> --status suspended
//   node scripts/admin_cli.js list-devices --license-id <id>
//   node scripts/admin_cli.js deactivate-device --device-id <id>
//   node scripts/admin_cli.js list-audit --business-id <id>

const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
const { randomToken, sha256Hex } = require("../src/crypto_utils");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function createBusiness(args) {
  if (!args.name) throw new Error("--name is required");
  const ref = db.collection("businesses").doc();
  const now = new Date().toISOString();
  await ref.set({
    name: args.name, contactEmail: args.email || null, country: args.country || null,
    notes: args.notes || null, status: "active", createdAt: now, updatedAt: now,
  });
  console.log(`Business created: ${ref.id}`);
}

async function createPlan(args) {
  const planId = args["plan-id"];
  const maxDevices = parseInt(args["max-devices"], 10);
  if (!planId || !args.name || !maxDevices) throw new Error("--plan-id, --name, --max-devices are required");
  const ref = db.collection("plans").doc(planId);
  if ((await ref.get()).exists) throw new Error("A plan with this id already exists.");
  const now = new Date().toISOString();
  const features = args.features ? args.features.split(",").map((f) => f.trim()) : [];
  await ref.set({
    name: args.name, priceCents: parseInt(args.price || "0", 10), currency: args.currency || "USD",
    billingPeriod: args.period || "monthly", maxDevices, features, productId: args.product || null,
    status: "active", createdAt: now, updatedAt: now,
  });
  console.log(`Plan created: ${planId}`);
}

async function createLicense(args) {
  const businessId = args["business-id"];
  const planId = args.plan;
  const maxDevices = parseInt(args["max-devices"], 10);
  if (!businessId || !planId || !maxDevices) throw new Error("--business-id, --plan, --max-devices are required");
  const businessSnap = await db.collection("businesses").doc(businessId).get();
  if (!businessSnap.exists) throw new Error("Business not found");
  const licenseKey = `LIC-${randomToken(20)}`;
  const ref = db.collection("licenses").doc();
  const now = new Date();
  const expiresAt = args.perpetual ? null : new Date(now.getTime() + (parseInt(args.days || "365", 10)) * 86400000).toISOString();
  const features = args.features ? args.features.split(",").map((f) => f.trim()) : [];
  await ref.set({
    businessId, planId, status: "active", maxDevices, features,
    licenseKeyHash: sha256Hex(licenseKey),
    issuedAt: now.toISOString(), expiresAt, version: 1,
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  });
  console.log(`License created: ${ref.id}`);
  console.log(`License key (shown once - give this to the customer): ${licenseKey}`);
}

async function renewLicense(args) {
  const licenseId = args["license-id"];
  if (!licenseId) throw new Error("--license-id is required");
  const ref = db.collection("licenses").doc(licenseId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("License not found");
  const updates = { updatedAt: new Date().toISOString(), version: (snap.data().version || 1) + 1, status: "active" };
  if (args.perpetual) updates.expiresAt = null;
  else if (args.days) updates.expiresAt = new Date(Date.now() + parseInt(args.days, 10) * 86400000).toISOString();
  if (args["max-devices"]) updates.maxDevices = parseInt(args["max-devices"], 10);
  await ref.update(updates);
  console.log(`License ${licenseId} renewed.`);
}

async function setStatus(args) {
  const licenseId = args["license-id"];
  const status = args.status;
  if (!licenseId || !["active", "suspended", "revoked", "expired"].includes(status)) {
    throw new Error("--license-id and a valid --status are required");
  }
  const ref = db.collection("licenses").doc(licenseId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("License not found");
  await ref.update({ status, updatedAt: new Date().toISOString(), version: (snap.data().version || 1) + 1 });
  console.log(`License ${licenseId} set to ${status}.`);
}

async function listDevices(args) {
  const licenseId = args["license-id"];
  if (!licenseId) throw new Error("--license-id is required");
  const snap = await db.collection("devices").where("licenseId", "==", licenseId).get();
  snap.docs.forEach((d) => {
    const v = d.data();
    console.log(`${d.id}  ${String(v.status).padEnd(12)}  ${v.platform}  activated=${v.activatedAt}  lastSeen=${v.lastSeenAt}`);
  });
  console.log(`${snap.size} device(s).`);
}

async function deactivateDevice(args) {
  const deviceId = args["device-id"];
  if (!deviceId) throw new Error("--device-id is required");
  await db.collection("devices").doc(deviceId).update({ status: "deactivated", deactivatedAt: new Date().toISOString() });
  console.log(`Device ${deviceId} deactivated.`);
}

async function listAudit(args) {
  const limit = parseInt(args.limit || "50", 10);
  let query = db.collection("auditLog").orderBy("at", "desc").limit(limit);
  if (args["business-id"]) {
    query = db.collection("auditLog").where("businessId", "==", args["business-id"]).orderBy("at", "desc").limit(limit);
  }
  const snap = await query.get();
  snap.docs.forEach((d) => {
    const v = d.data();
    console.log(`${v.at}  ${v.type}  business=${v.businessId || "-"}  license=${v.licenseId || "-"}  device=${v.deviceId || "-"}`);
  });
}

const COMMANDS = {
  "create-business": createBusiness,
  "create-plan": createPlan,
  "create-license": createLicense,
  "renew-license": renewLicense,
  "set-status": setStatus,
  "list-devices": listDevices,
  "deactivate-device": deactivateDevice,
  "list-audit": listAudit,
};

async function main() {
  const [, , command, ...rest] = process.argv;
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`Usage: node scripts/admin_cli.js <${Object.keys(COMMANDS).join("|")}> [--flag value ...]`);
    process.exit(1);
  }
  await fn(parseArgs(rest));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
