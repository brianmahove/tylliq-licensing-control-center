const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest, PUBLIC_MAX_INSTANCES } = require('./https_utils');
const { db } = require('./firebase_admin');
const { ok, fail, sendJson } = require('./response_utils');
const { withCors } = require('./cors_utils');
const { requireAppCheck } = require('./app_check_utils');
const { checkSyncRateLimit } = require('./rate_limit');
const { sha256Hex } = require('./crypto_utils');
const { effectiveStatus } = require('./license_status');
const { writeAuditLog } = require('./audit');

const EPOCH_ISO = new Date(0).toISOString();
const MAX_DELTAS_PER_PULL = 500;
const RETENTION_DAYS = 45;
const CLEANUP_BATCH_SIZE = 400;
const CLEANUP_MAX_BATCHES = 10; // bounds one scheduled run's cost; a bigger backlog just finishes over more runs

// Every syncable table SyncBundle carries (see lib/sync/sync_bundle.dart) -
// keep this in lockstep with that class's field list.
const BUNDLE_ARRAY_KEYS = [
  'products', 'productVariants', 'stockMovements', 'sales', 'saleItems', 'staffMembers',
  'categories', 'suppliers', 'expenses', 'cashClosings',
];

function isBundleEmpty(bundle) {
  if (!bundle) return true;
  if (bundle.shopSettings) return false;
  return BUNDLE_ARRAY_KEYS.every((key) => !Array.isArray(bundle[key]) || bundle[key].length === 0);
}

/**
 * Concatenates every syncDeltas doc pulled for this business into the single
 * bundle shape the client's SyncBundle.fromJson expects. Row-level conflict
 * handling already lives in the client's mergeProduct/mergeSale/etc (last
 * updatedAt wins), so duplicate or stale rows surviving here are harmless,
 * just redundant.
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} docs ordered oldest-first
 * @return {Object} merged bundle
 */
function mergeDeltaDocs(docs) {
  const merged = { shopSettings: null };
  for (const key of BUNDLE_ARRAY_KEYS) merged[key] = [];
  for (const doc of docs) {
    const bundle = doc.data().bundle || {};
    if (bundle.shopSettings) merged.shopSettings = bundle.shopSettings;
    for (const key of BUNDLE_ARRAY_KEYS) {
      if (Array.isArray(bundle[key])) merged[key].push(...bundle[key]);
    }
  }
  return merged;
}

/**
 * Lets an already-activated device push its local changes and pull back
 * whatever the rest of its business's devices have pushed since it last
 * checked in - the cloud counterpart to the phone-to-phone LAN sync in
 * lib/sync/sync_client.dart + sync_server.dart, for devices that aren't on
 * the same network often enough for that to work.
 *
 * Trust model: identical to revalidateDevice above - the deviceId +
 * deviceSecret pair issued at activation is the only credential, and the
 * businessId a device is scoped to is read off its own `devices/{id}` doc,
 * never taken from the request body. A client cannot claim to belong to a
 * different business no matter what it sends, and Firestore rules deny all
 * direct client access anyway (see firestore.rules) - this function is the
 * only thing that ever reads or writes `syncDeltas`.
 */
exports.syncData = onRequest(withCors(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, fail('invalid-argument', 'POST required'));
  if (!(await requireAppCheck(req, res))) return;
  const { deviceId, deviceSecret, bundle = null } = req.body || {};
  if (!deviceId || !deviceSecret) {
    return sendJson(res, 400, fail('invalid-argument', 'deviceId and deviceSecret are required'));
  }
  const ip = req.ip || req.headers['x-forwarded-for'] || null;
  if (!(await checkSyncRateLimit(ip))) {
    return sendJson(res, 429, fail('resource-exhausted', 'Too many sync attempts. Try again later.'));
  }

  const deviceRef = db.collection('devices').doc(deviceId);
  const deviceSnap = await deviceRef.get();
  if (!deviceSnap.exists || sha256Hex(deviceSecret) !== deviceSnap.data().deviceSecretHash) {
    await writeAuditLog({ type: 'sync_rejected', deviceId, meta: { reason: 'bad_credentials', ip } });
    return sendJson(res, 401, fail('unauthenticated', 'Device credentials not recognized.'));
  }
  const device = deviceSnap.data();
  if (device.status !== 'active') {
    await deviceRef.update({ lastSeenAt: new Date().toISOString() });
    return sendJson(res, 403, fail('failed-precondition', 'This device has been deactivated.'));
  }

  const licenseSnap = await db.collection('licenses').doc(device.licenseId).get();
  if (!licenseSnap.exists) {
    return sendJson(res, 404, fail('not-found', 'License not found.'));
  }
  const now = new Date();
  const status = effectiveStatus(licenseSnap.data(), now.getTime());
  if (status !== 'active') {
    return sendJson(res, 403, fail('failed-precondition', `This license is ${status}.`));
  }

  if (!isBundleEmpty(bundle)) {
    await db.collection('syncDeltas').add({
      businessId: device.businessId,
      authorDeviceId: deviceId,
      createdAt: now.toISOString(),
      bundle,
    });
  }

  const since = device.lastSyncPulledAt || EPOCH_ISO;
  const deltasSnap = await db.collection('syncDeltas')
    .where('businessId', '==', device.businessId)
    .where('createdAt', '>', since)
    .orderBy('createdAt', 'asc')
    .limit(MAX_DELTAS_PER_PULL)
    .get();
  const otherDocs = deltasSnap.docs.filter((d) => d.data().authorDeviceId !== deviceId);
  const outgoingBundle = mergeDeltaDocs(otherDocs);

  // Cursor advances to the last delta actually fetched (which may be this
  // device's own delta just written above), not to `now` - if
  // MAX_DELTAS_PER_PULL was hit, anything past it must still be picked up on
  // the next call rather than silently skipped.
  const newCursor = deltasSnap.docs.length > 0 ?
    deltasSnap.docs[deltasSnap.docs.length - 1].data().createdAt :
    now.toISOString();
  await deviceRef.update({ lastSyncPulledAt: newCursor, lastSeenAt: now.toISOString() });

  return sendJson(res, 200, ok({ bundle: outgoingBundle, serverTime: now.toISOString() }));
}), { maxInstances: PUBLIC_MAX_INSTANCES });

/**
 * Prunes syncDeltas older than every active device should plausibly still
 * need (see RETENTION_DAYS). A device offline longer than that would need a
 * full resync rather than relying on the delta log - same escape hatch as
 * the LAN sync path re-sending everything since epoch.
 */
exports.cleanupSyncDeltas = onSchedule('every 24 hours', async () => {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  for (let i = 0; i < CLEANUP_MAX_BATCHES; i++) {
    const snap = await db.collection('syncDeltas').where('createdAt', '<', cutoff).limit(CLEANUP_BATCH_SIZE).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snap.size < CLEANUP_BATCH_SIZE) return;
  }
});
