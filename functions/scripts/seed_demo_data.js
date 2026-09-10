#!/usr/bin/env node

const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const now = Date.now();
const iso = (offsetDays = 0) => new Date(now + offsetDays * 86400000).toISOString();
const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const businesses = [
  {
    id: 'demo-acme-hardware',
    name: 'Acme Hardware',
    contactEmail: 'ops@acme-hardware.test',
    country: 'US',
    notes: 'Primary demo account with a healthy active license.',
    status: 'active',
    createdAt: iso(-45),
  },
  {
    id: 'demo-northstar-retail',
    name: 'Northstar Retail Group',
    contactEmail: 'licenses@northstar-retail.test',
    country: 'CA',
    notes: 'Multi-location retailer with an expiring license.',
    status: 'active',
    createdAt: iso(-30),
  },
  {
    id: 'demo-pixel-cafe',
    name: 'Pixel Cafe',
    contactEmail: 'owner@pixel-cafe.test',
    country: 'GB',
    notes: 'Suspended account for support workflow testing.',
    status: 'suspended',
    createdAt: iso(-20),
  },
  {
    id: 'demo-orbit-warehouse',
    name: 'Orbit Warehouse',
    contactEmail: 'admin@orbit-warehouse.test',
    country: 'AU',
    notes: 'Legacy account with revoked and expired entitlements.',
    status: 'active',
    createdAt: iso(-12),
  },
];

const plans = [
  { id: 'starter', name: 'Starter', priceCents: 1900, billingPeriod: 'monthly', maxDevices: 1,
    features: ['pos'], productId: 'tylliq-starter' },
  { id: 'professional', name: 'Professional', priceCents: 7900, billingPeriod: 'monthly', maxDevices: 5,
    features: ['pos', 'inventory', 'reports'], productId: 'tylliq-professional' },
  { id: 'enterprise', name: 'Enterprise', priceCents: 24900, billingPeriod: 'annual', maxDevices: 25,
    features: ['pos', 'inventory', 'reports', 'multi_location', 'priority_support'], productId: 'tylliq-enterprise' },
];

const features = [
  { id: 'pos', label: 'Point of sale', description: 'Core checkout and transaction workflows',
    productId: 'tylliq-core' },
  { id: 'inventory', label: 'Inventory', description: 'Stock levels, transfers, and adjustments',
    productId: 'tylliq-core' },
  { id: 'reports', label: 'Reports', description: 'Sales and operational reporting', productId: 'tylliq-core' },
  { id: 'multi_location', label: 'Multi-location', description: 'Manage multiple branches from one account',
    productId: 'tylliq-enterprise' },
  { id: 'priority_support', label: 'Priority support', description: 'Accelerated support response times',
    productId: 'tylliq-enterprise' },
];

const licenseDefinitions = [
  { id: 'demo-license-acme-active', businessId: 'demo-acme-hardware', planId: 'professional', status: 'active',
    maxDevices: 5, features: ['pos', 'inventory', 'reports'], expiresAt: 90, key: 'LIC-DEMO-ACME-ACTIVE' },
  { id: 'demo-license-northstar-expiring', businessId: 'demo-northstar-retail', planId: 'enterprise', status: 'active',
    maxDevices: 25, features: ['pos', 'inventory', 'reports', 'multi_location'], expiresAt: 3,
    key: 'LIC-DEMO-NORTHSTAR-EXPIRING' },
  { id: 'demo-license-pixel-suspended', businessId: 'demo-pixel-cafe', planId: 'starter', status: 'suspended',
    maxDevices: 1, features: ['pos'], expiresAt: 180, key: 'LIC-DEMO-PIXEL-SUSPENDED' },
  { id: 'demo-license-orbit-revoked', businessId: 'demo-orbit-warehouse', planId: 'professional', status: 'revoked',
    maxDevices: 5, features: ['pos', 'inventory'], expiresAt: 120, key: 'LIC-DEMO-ORBIT-REVOKED' },
  { id: 'demo-license-orbit-expired', businessId: 'demo-orbit-warehouse', planId: 'starter', status: 'expired',
    maxDevices: 1, features: ['pos'], expiresAt: -10, key: 'LIC-DEMO-ORBIT-EXPIRED' },
  { id: 'demo-license-acme-perpetual', businessId: 'demo-acme-hardware', planId: 'enterprise', status: 'active',
    maxDevices: 25, features: ['pos', 'inventory', 'reports', 'multi_location', 'priority_support'],
    expiresAt: null, key: 'LIC-DEMO-ACME-PERPETUAL' },
];

const devices = [
  { id: 'demo-device-acme-counter', businessId: 'demo-acme-hardware', licenseId: 'demo-license-acme-active',
    platform: 'android', appVersion: '2.4.1', deviceLabel: 'Front counter', status: 'active', daysAgo: 0 },
  { id: 'demo-device-acme-office', businessId: 'demo-acme-hardware', licenseId: 'demo-license-acme-active',
    platform: 'windows', appVersion: '2.4.0', deviceLabel: 'Back office', status: 'active', daysAgo: 2 },
  { id: 'demo-device-northstar-01', businessId: 'demo-northstar-retail', licenseId: 'demo-license-northstar-expiring',
    platform: 'ios', appVersion: '2.3.8', deviceLabel: 'Toronto store 01', status: 'active', daysAgo: 1 },
  { id: 'demo-device-pixel-old', businessId: 'demo-pixel-cafe', licenseId: 'demo-license-pixel-suspended',
    platform: 'android', appVersion: '2.2.5', deviceLabel: 'Cafe tablet', status: 'deactivated', daysAgo: 18 },
  { id: 'demo-device-orbit-old', businessId: 'demo-orbit-warehouse', licenseId: 'demo-license-orbit-revoked',
    platform: 'linux', appVersion: '2.1.0', deviceLabel: 'Warehouse terminal', status: 'deactivated', daysAgo: 30 },
];

const payments = [
  { id: 'demo-payment-confirmed', businessId: 'demo-acme-hardware', licenseId: 'demo-license-acme-active',
    amountCents: 7900, method: 'bank_transfer', status: 'confirmed', reference: 'BANK-DEMO-1001', daysAgo: 4 },
  { id: 'demo-payment-pending', businessId: 'demo-northstar-retail', licenseId: 'demo-license-northstar-expiring',
    amountCents: 24900, method: 'ecocash', status: 'pending', reference: 'ECO-DEMO-2001', daysAgo: 1 },
  { id: 'demo-payment-rejected', businessId: 'demo-pixel-cafe', licenseId: 'demo-license-pixel-suspended',
    amountCents: 1900, method: 'whatsapp', status: 'rejected', reference: 'WA-DEMO-3001', daysAgo: 8 },
  { id: 'demo-payment-refunded', businessId: 'demo-orbit-warehouse', licenseId: 'demo-license-orbit-revoked',
    amountCents: 7900, method: 'bank_transfer', status: 'refunded', reference: 'BANK-DEMO-4001', daysAgo: 22 },
];

const auditEvents = [
  ['business_created', 'demo-acme-hardware', null, null, -45],
  ['license_created', 'demo-acme-hardware', 'demo-license-acme-active', null, -40],
  ['activation_approved', 'demo-acme-hardware', 'demo-license-acme-active', 'demo-device-acme-counter', -35],
  ['activation_approved', 'demo-acme-hardware', 'demo-license-acme-active', 'demo-device-acme-office', -2],
  ['payment_recorded', 'demo-northstar-retail', 'demo-license-northstar-expiring', null, -1],
  ['activation_approved', 'demo-northstar-retail', 'demo-license-northstar-expiring', 'demo-device-northstar-01', -1],
  ['activation_rejected', 'demo-pixel-cafe', 'demo-license-pixel-suspended', 'demo-device-pixel-new', -5],
  ['activation_rejected', 'demo-orbit-warehouse', 'demo-license-orbit-revoked', 'demo-device-orbit-new', -10],
  ['license_revoked', 'demo-orbit-warehouse', 'demo-license-orbit-revoked', null, -20],
  ['device_deactivated', 'demo-pixel-cafe', 'demo-license-pixel-suspended', 'demo-device-pixel-old', -18],
];

async function seed() {
  const batch = db.batch();

  businesses.forEach(({ id, createdAt, ...business }) => {
    batch.set(db.collection('businesses').doc(id), { ...business, createdAt, updatedAt: iso(0) }, { merge: true });
  });

  plans.forEach(({ id, ...plan }) => {
    batch.set(db.collection('plans').doc(id), {
      ...plan, currency: 'USD', status: 'active', createdAt: iso(-45), updatedAt: iso(0),
    }, { merge: true });
  });

  features.forEach(({ id, ...feature }) => {
    batch.set(db.collection('features').doc(id), {
      ...feature, createdAt: iso(-45), updatedAt: iso(0),
    }, { merge: true });
  });

  licenseDefinitions.forEach(({ id, expiresAt, key, ...license }) => {
    batch.set(db.collection('licenses').doc(id), {
      ...license,
      licenseKeyHash: hash(key),
      issuedAt: iso(-30),
      expiresAt: expiresAt === null ? null : iso(expiresAt),
      version: 1,
      createdAt: iso(-30),
      updatedAt: iso(0),
    }, { merge: true });
  });

  devices.forEach(({ id, daysAgo, ...device }) => {
    batch.set(db.collection('devices').doc(id), {
      ...device,
      deviceSecretHash: hash(`demo-secret-${id}`),
      activatedAt: iso(-Math.max(daysAgo, 1)),
      lastSeenAt: iso(-daysAgo),
      branchId: null,
      deactivatedAt: device.status === 'deactivated' ? iso(-Math.max(daysAgo - 1, 1)) : null,
    }, { merge: true });
  });

  payments.forEach(({ id, daysAgo, ...payment }) => {
    const timestamp = iso(-daysAgo);
    batch.set(db.collection('payments').doc(id), {
      ...payment,
      currency: 'USD',
      notes: `Demo ${payment.status} payment`,
      createdAt: timestamp,
      updatedAt: timestamp,
      confirmedBy: payment.status === 'confirmed' ? 'demo-admin' : null,
    }, { merge: true });
  });

  auditEvents.forEach(([type, businessId, licenseId, deviceId, daysAgo], index) => {
    batch.set(db.collection('auditLog').doc(`demo-event-${String(index + 1).padStart(2, '0')}`), {
      type,
      businessId,
      licenseId,
      deviceId,
      meta: { seeded: true, scenario: type },
      at: iso(daysAgo),
    }, { merge: true });
  });

  await batch.commit();
  console.log('Seeded demo data for all licensing scenarios.');
  console.log('Demo license keys:');
  licenseDefinitions.forEach(({ id, key }) => console.log(`  ${id}: ${key}`));
}

seed().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
