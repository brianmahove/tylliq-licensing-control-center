import './styles.css';
import { initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';

const firebaseApp = initializeApp({
  apiKey: 'demo-api-key',
  authDomain: 'tylliq-licensing.firebaseapp.com',
  projectId: 'tylliq-licensing',
  appId: 'demo-app-id',
});
const auth = getAuth(firebaseApp);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });

const FUNCTION_BASE = 'http://127.0.0.1:5001/tylliq-licensing/us-central1';
const state = { view: 'overview', user: null, data: null, loading: false, booting: true, search: '', filter: 'all', modal: null };

const app = document.querySelector('#app');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

function formatNumber(value) {
  return value === undefined || value === null ? '—' : new Intl.NumberFormat('en-US').format(value);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function statusPill(status) {
  const tone = ['active', 'confirmed', 'approved'].includes(status) ? 'good' :
    ['suspended', 'pending'].includes(status) ? 'warn' : 'bad';
  return `<span class="status ${tone}"><i></i>${escapeHtml(status || 'unknown')}</span>`;
}

function shieldIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 19 6v5c0 4.4-2.9 8.4-7 10-4.1-1.6-7-5.6-7-10V6l7-3Z"/><path d="m8.7 12 2.1 2.1 4.5-4.6"/></svg>';
}

function renderLoading() {
  app.innerHTML = `<main class="loading-screen"><div class="loading-logo">${shieldIcon()}</div><h1>Licensing Control Center</h1><p>Loading your administration panel...</p><span class="spinner"></span></main>`;
}

function renderLogin(error = '') {
  app.innerHTML = `<main class="login-shell">
    <section class="login-panel">
      <div class="login-brand"><span class="brand-mark">${shieldIcon()}</span><strong>Licensing Control Center</strong></div>
      <p class="eyebrow">SECURE ADMINISTRATION</p>
      <h1>Licensing operations,<br><em>under control.</em></h1>
      <p class="login-copy">Manage businesses, entitlements, devices, and the audit trail from one secure workspace.</p>
      <form id="login-form" class="login-form">
        <label>Email address<input name="email" type="email" placeholder="admin@company.com" required /></label>
        <label>Password<input name="password" type="password" placeholder="Enter your password" required /></label>
        ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ''}
        <div class="form-row"><label class="check-label"><input type="checkbox" /> Remember me</label><button class="text-button" type="button">Forgot password?</button></div>
        <button class="primary-button" type="submit">Sign in <span>↗</span></button>
      </form>
      <p class="login-hint">Authorized administrators only</p>
    </section>
    <aside class="login-art"><div class="art-grid"></div><div class="art-note">02<br><small>LICENSE<br>HEALTH</small></div><div class="art-word">TYLLIQ</div></aside>
  </main>`;
  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    button.textContent = 'Signing in...';
    try {
      await signInWithEmailAndPassword(auth, form.get('email'), form.get('password'));
    } catch (authError) {
      renderLogin(authError.code === 'auth/invalid-credential' ? 'Email or password not recognized.' : authError.message);
    }
  });
}

async function apiCall(functionName, body = {}) {
  const token = await state.user.getIdToken();
  const response = await fetch(`${FUNCTION_BASE}/${functionName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error?.message || `Request failed (${response.status})`);
  return payload;
}

async function loadDashboard() {
  state.loading = true;
  renderApp();
  try {
    state.data = await apiCall('adminGetDashboardStats');
  } catch (error) {
    state.data = { error: error.message };
  } finally {
    state.loading = false;
    renderApp();
  }
}

function statCard(label, value, detail, accent = '') {
  return `<article class="stat-card ${accent}"><div class="stat-heading"><p>${label}</p><span class="metric-icon">${accent === 'green' ? '✓' : accent === 'rose' ? '!' : accent === 'blue' ? '⌁' : '◷'}</span></div><strong>${formatNumber(value)}</strong><span>${detail || 'No data available'}</span></article>`;
}

function healthPercent(licenses) {
  const total = (licenses.active || 0) + (licenses.suspended || 0) + (licenses.revoked || 0) + (licenses.expired || 0);
  return total ? Math.round((licenses.active || 0) / total * 100) : 0;
}

function activityChart(activity) {
  if (!activity.length) return '<div class="chart-empty">Chart data will appear here when provided by the backend.</div>';
  const ordered = [...activity].sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  const rejected = [];
  let rejectedTotal = 0;
  ordered.forEach((item, index) => {
    if (item.type === 'activation_rejected') rejectedTotal += 1;
    rejected.push(rejectedTotal);
    ordered[index] = { ...item, eventTotal: index + 1 };
  });
  const max = Math.max(ordered.length, rejectedTotal, 1);
  const points = (values) => values.map((value, index) => `${(index / Math.max(values.length - 1, 1)) * 100},${36 - (value / max) * 30}`).join(' ');
  return `<svg class="activity-chart" viewBox="0 0 100 40" preserveAspectRatio="none" aria-label="Activity events chart"><polyline class="chart-line activity-line" points="${points(ordered.map((item) => item.eventTotal))}" /><polyline class="chart-line rejected-line" points="${points(rejected)}" /></svg>`;
}

function overviewContent() {
  const data = state.data || {};
  if (state.loading) return '<div class="loading">Loading control center<span>...</span></div>';
  if (data.error) return `<div class="empty-state"><strong>Could not load the dashboard</strong><p>${escapeHtml(data.error)}</p><button class="secondary-button" data-action="refresh">Retry</button></div>`;
  const businesses = data.businesses || {};
  const licenses = data.licenses || {};
  const devices = data.devices || {};
  const activity = data.recentActivity || [];
  const failed = data.failedActivationsLast20 || [];
  return `<div class="stats-grid">
    ${statCard('Total businesses', businesses.total, 'all registered businesses', 'orange')}
    ${statCard('Active licenses', licenses.active, 'currently active', 'green')}
    ${statCard('Activated devices', devices.total, 'registered devices', 'blue')}
    ${statCard('Expiring soon', licenses.expiringSoon, 'within the next 7 days', 'orange')}
    ${statCard('Expired licenses', licenses.expired, 'require renewal', 'rose')}
    ${statCard('Online devices', devices.active, 'currently active', 'blue')}
    ${statCard('Failed activations', failed.length, 'recent rejected attempts', 'rose')}
    ${statCard('Suspicious activity', undefined, 'No data available', 'rose')}
  </div>
  <section class="panel chart-panel"><div class="panel-heading"><div><p class="eyebrow">LICENSE ACTIVITY</p><h2>Licensing activity over time</h2></div><span class="record-count">${activity.length ? 'Live records' : 'Dynamic data'}</span></div><div class="chart-placeholder"><div class="chart-y-axis"><span>—</span><span>—</span><span>—</span><span>—</span></div><div class="chart-grid"><span></span><span></span><span></span><span></span>${activityChart(activity)}<div class="chart-x-axis"><span>—</span><span>—</span><span>—</span><span>—</span><span>—</span></div></div></div><div class="chart-legend"><span><i class="dot green-dot"></i>Activity events</span><span><i class="dot red-dot"></i>Rejected activations</span></div></section>
  <section class="content-grid">
    <article class="panel activity-panel"><div class="panel-heading"><div><p class="eyebrow">LIVE FEED</p><h2>Recent activity</h2></div><button class="icon-button" data-action="refresh" title="Refresh activity">↻</button></div>
      ${activity.length ? `<div class="activity-list">${activity.map((item) => `<div class="activity-row"><span class="activity-dot"></span><div><strong>${escapeHtml((item.type || 'event').replaceAll('_', ' '))}</strong><small>${escapeHtml(item.businessId || 'System event')}</small></div><time>${escapeHtml(item.at || '')}</time></div>`).join('')}</div>` : '<div class="blank">No activity recorded yet.</div>'}
    </article>
    <article class="panel health-panel"><p class="eyebrow">LICENSE HEALTH</p><h2>Portfolio pulse</h2><div class="health-ring" style="--health:${healthPercent(licenses)}%"><strong>${formatNumber(licenses.active)}</strong><span>active</span></div><div class="legend"><span><i class="dot green-dot"></i>Active <b>${formatNumber(licenses.active)}</b></span><span><i class="dot yellow-dot"></i>Suspended <b>${formatNumber(licenses.suspended)}</b></span><span><i class="dot red-dot"></i>Revoked <b>${formatNumber(licenses.revoked)}</b></span><span><i class="dot blue-dot"></i>Expired <b>${formatNumber(licenses.expired)}</b></span></div></article>
  </section>`;
}

function listContent(view) {
  const configs = {
    businesses: ['Businesses', 'businesses', ['name', 'status', 'contactEmail', 'country']],
    licenses: ['Licenses', 'licenses', ['licenseId', 'businessId', 'planId', 'status', 'expiresAt']],
    devices: ['Devices', 'devices', ['deviceId', 'businessId', 'platform', 'status', 'lastSeenAt']],
    plans: ['Plans', 'plans', ['planId', 'name', 'maxDevices', 'features', 'status']],
    payments: ['Payments', 'payments', ['paymentId', 'businessId', 'amountCents', 'method', 'status', 'createdAt']],
    features: ['Features', 'features', ['key', 'label', 'productId', 'createdAt']],
    audit: ['Audit Log', 'events', ['type', 'businessId', 'licenseId', 'deviceId', 'at']],
    attempts: ['Activation Attempts', 'events', ['type', 'businessId', 'licenseId', 'deviceId', 'at']],
  };
  if (view === 'settings') return settingsContent();
  const config = configs[view];
  if (state.loading) return '<div class="loading">Loading records<span>...</span></div>';
  if (!state.data || state.data.error) return `<div class="empty-state"><strong>${escapeHtml(state.data?.error || 'No data loaded')}</strong></div>`;
  let rows = state.data[config[1]] || [];
  if (view === 'attempts') rows = rows.filter((row) => ['activation_approved', 'activation_rejected'].includes(row.type));
  if (state.search) rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(state.search.toLowerCase()));
  if (state.filter !== 'all' && rows.some((row) => row.status)) rows = rows.filter((row) => row.status === state.filter);
  const cell = (row, key) => {
    if (key === 'status' || key === 'type' && row.type?.includes('approved')) return key === 'status' ? statusPill(row[key]) : statusPill('approved');
    if (key === 'expiresAt' || key === 'createdAt' || key === 'lastSeenAt' || key === 'at') return escapeHtml(formatDate(row[key]));
    if (key === 'amountCents') return escapeHtml(`$${((row[key] || 0) / 100).toFixed(2)}`);
    if (Array.isArray(row[key])) return escapeHtml(row[key].join(', '));
    return escapeHtml(row[key] ?? '—');
  };
  const actionLabel = ['businesses', 'licenses', 'plans'].includes(view) ? (view === 'licenses' ? 'Issue License' : `Add ${config[0].slice(0, -1)}`) : '';
  const actionType = view === 'licenses' ? 'license' : view === 'businesses' ? 'business' : 'plan';
  return `<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">DIRECTORY</p><h2>${config[0]}</h2></div><div class="panel-actions">${actionLabel ? `<button class="primary-button compact-button" data-action="notice">${actionLabel}</button>` : ''}<span class="record-count">${rows.length} records</span></div></div><div class="table-tools"><input class="table-search" data-action="search" value="${escapeHtml(state.search)}" placeholder="Search ${config[0].toLowerCase()}..." /><select data-action="filter"><option value="all">All statuses</option><option value="active">Active</option><option value="pending">Pending</option><option value="confirmed">Confirmed</option><option value="suspended">Suspended</option><option value="expired">Expired</option><option value="revoked">Revoked</option></select><button class="secondary-button filter-button" data-action="filter-reset">Reset</button></div><div class="table-wrap"><table><thead><tr>${config[2].map((key) => `<th>${escapeHtml(key.replace(/([A-Z])/g, ' $1'))}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((row) => `<tr>${config[2].map((key) => `<td>${cell(row, key)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${config[2].length}" class="blank"><span class="empty-icon">○</span><strong>No ${config[0].toLowerCase()} available</strong><small>Data will appear here when provided by the backend.</small></td></tr>`}</tbody></table></div><div class="table-footer"><span>Showing ${rows.length} records</span><span>Rows per page <select><option>25</option><option>50</option><option>100</option></select>　‹　<strong>1</strong>　›</span></div></section>`;
}

function settingsContent() {
  return `<section class="settings-grid"><article class="panel settings-card"><p class="eyebrow">GENERAL SETTINGS</p><h2>Workspace preferences</h2><label>Company name<input placeholder="Company name" /></label><label>Currency<select><option>Select currency</option></select></label><label>Receipt footer<input placeholder="Optional receipt footer" /></label><button class="primary-button">Save changes</button></article><article class="panel settings-card"><p class="eyebrow">LICENSE & BACKUP</p><h2>Operational safeguards</h2><div class="setting-row"><span><strong>License activation</strong><small>Configuration supplied by backend</small></span><span class="status"><i></i>—</span></div><div class="setting-row"><span><strong>Backup status</strong><small>No backup status available</small></span><span class="status"><i></i>—</span></div><button class="secondary-button">Export backup</button></article><article class="panel settings-card"><p class="eyebrow">SHOP & DEVICE IDS</p><h2>Identifiers</h2><div class="id-field"><span>Shop ID</span><strong>—</strong><button class="icon-button" title="Copy shop ID">⧉</button></div><div class="id-field"><span>Device ID</span><strong>—</strong><button class="icon-button" title="Copy device ID">⧉</button></div></article><article class="panel settings-card"><p class="eyebrow">SECURITY</p><h2>Administrator settings</h2><div class="setting-row"><span><strong>Signed in account</strong><small>${escapeHtml(state.user?.email || '—')}</small></span><span class="status good"><i></i>Active</span></div><button class="secondary-button">Manage profile</button></article></section>`;
}

function modalContent() {
  if (!state.modal) return '';
  const title = state.modal === 'license' ? 'Issue License' : `Add ${state.modal}`;
  const fields = state.modal === 'license' ? '<label>Business<select><option>Select business</option></select></label><label>Plan<select><option>Select plan</option></select></label><label>Maximum devices<input type="number" placeholder="Maximum devices" /></label><label>Start date<input type="date" /></label><label>Expiry date<input type="date" /></label><label>Enabled features<input placeholder="Select features" /></label>' : state.modal === 'business' ? '<label>Business name<input placeholder="Business name" required /></label><label>Contact email<input type="email" placeholder="Contact email" /></label><label>Country<input placeholder="Country" /></label>' : '<label>Plan name<input placeholder="Plan name" required /></label><label>Maximum devices<input type="number" placeholder="Maximum devices" required /></label><label>Billing period<select><option>Select billing period</option></select></label><label>Enabled features<input placeholder="Select features" /></label>';
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog"><button class="modal-close" data-action="close-modal" aria-label="Close">×</button><p class="eyebrow">ADMINISTRATION</p><h2>${title}</h2><p class="modal-copy">Values are validated and submitted through the existing backend.</p><form id="entity-form" class="entity-form">${fields}<div class="modal-actions"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button type="submit" class="primary-button">${title}</button></div></form></section></div>`;
}

async function loadViewData() {
  state.loading = true;
  renderApp();
  try {
    if (state.view === 'overview') state.data = await apiCall('adminGetDashboardStats');
    else if (state.view === 'settings') state.data = {};
    else {
      const endpoint = { businesses: 'adminListBusinesses', licenses: 'adminListLicenses', devices: 'adminListDevices', plans: 'adminListPlans', payments: 'adminListPayments', features: 'adminListFeatures', audit: 'adminListAuditLog', attempts: 'adminListAuditLog' }[state.view];
      state.data = await apiCall(endpoint, state.view === 'attempts' ? { limit: 200 } : {});
    }
  } catch (error) { state.data = { error: error.message }; }
  state.loading = false;
  renderApp();
}

function renderApp() {
  if (!state.user) return renderLogin();
  const navItems = [['overview', 'Dashboard'], ['businesses', 'Businesses'], ['licenses', 'Licenses'], ['devices', 'Devices'], ['plans', 'Plans'], ['payments', 'Payments'], ['features', 'Features'], ['attempts', 'Activation Attempts'], ['audit', 'Audit Log'], ['settings', 'Settings']];
  const titles = { overview: ['Dashboard', 'Overview of your licensing platform.'], businesses: ['Businesses', 'Manage all registered businesses.'], licenses: ['Licenses', 'Issue, monitor, and protect access.'], devices: ['Devices', 'See what is connected right now.'], plans: ['Plans', 'The commercial rules behind every license.'], payments: ['Payments', 'Review and reconcile customer payments.'], features: ['Features', 'Manage product capabilities and entitlements.'], attempts: ['Activation Attempts', 'Track approved and rejected device activations.'], audit: ['Audit Log', 'A complete history of administrative activity.'], settings: ['Settings', 'Configure your licensing workspace.'] };
  const title = titles[state.view];
  app.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="sidebar-brand"><span class="brand-mark small">${shieldIcon()}</span><span>Licensing<br>Control Center</span></div><p class="nav-label">ADMINISTRATION</p><nav>${navItems.map(([id, label]) => `<button class="nav-item ${state.view === id ? 'active' : ''}" data-view="${id}"><span class="nav-icon">${id === 'overview' ? '◈' : id === 'businesses' ? '◎' : id === 'licenses' ? '◇' : id === 'devices' ? '⌁' : id === 'plans' ? '▦' : id === 'payments' ? '$' : id === 'features' ? '✦' : id === 'attempts' ? '↗' : id === 'audit' ? '≡' : '⚙'}</span>${label}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="connection"><span></span><div><strong>System status</strong><small>Awaiting status</small></div></div><small class="version">Version —</small><button class="signout" data-action="signout">Sign out</button></div></aside><main class="main-content"><header class="topbar"><div class="global-search"><span>⌕</span><input placeholder="Search businesses, licenses, devices..." /></div><div class="top-actions"><button class="icon-button" title="Notifications">♧</button><button class="icon-button" data-action="refresh" title="Refresh">↻</button><div class="avatar">${escapeHtml((state.user.email || 'A').slice(0, 1).toUpperCase())}</div><button class="admin-menu">Admin⌄</button></div></header><div class="page-heading"><div><p class="breadcrumb">CONTROL CENTER / ${state.view.toUpperCase()}</p><h1>${title[0]}</h1><p class="subtitle">${title[1]}</p></div></div><div class="content">${state.view === 'overview' ? overviewContent() : listContent(state.view)}</div></main>${modalContent()}</div>`;
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.view; state.search = ''; state.filter = 'all'; loadViewData(); }));
  document.querySelectorAll('[data-action="refresh"]').forEach((button) => button.addEventListener('click', loadViewData));
  document.querySelector('[data-action="search"]')?.addEventListener('input', (event) => { state.search = event.target.value; renderApp(); document.querySelector('[data-action="search"]')?.focus(); });
  document.querySelector('[data-action="filter"]')?.addEventListener('change', (event) => { state.filter = event.target.value; renderApp(); });
  document.querySelector('[data-action="filter-reset"]')?.addEventListener('click', () => { state.search = ''; state.filter = 'all'; renderApp(); });
  document.querySelectorAll('[data-action="notice"]').forEach((button) => button.addEventListener('click', () => { state.modal = state.view === 'licenses' ? 'license' : state.view === 'businesses' ? 'business' : 'plan'; renderApp(); }));
  document.querySelectorAll('[data-action="close-modal"]').forEach((button) => button.addEventListener('click', (event) => { if (event.target === button) { state.modal = null; renderApp(); } }));
  document.querySelector('#entity-form')?.addEventListener('submit', (event) => { event.preventDefault(); state.modal = null; renderApp(); });
  document.querySelector('[data-action="signout"]').addEventListener('click', () => signOut(auth));
}

renderLoading();
onAuthStateChanged(auth, (user) => { state.booting = false; state.user = user; if (user) loadViewData(); else renderLogin(); });
