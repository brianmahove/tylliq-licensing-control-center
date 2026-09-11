import './styles.css';
import { onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { auth, apiCall } from './api.js';
import { icon, navIcon } from './icons.js';
import { escapeHtml, formatNumber, formatDate, formatDateTime, formatRelative, formatMoney, initials, titleCase } from './format.js';

const APP_VERSION = '1.0.0';
const ROLE_LABELS = {
  super_admin: 'Super Admin — full access to every workspace area',
  license_admin: 'License Admin — manage businesses, licenses, and plans',
  support_admin: 'Support Admin — manage devices and activation issues',
  finance_admin: 'Finance Admin — manage and confirm payments',
  read_only: 'Read Only — can view records, cannot make changes',
};
const NAV_ITEMS = [
  ['overview', 'Dashboard'], ['businesses', 'Businesses'], ['licenses', 'Licenses'], ['devices', 'Devices'],
  ['plans', 'Plans'], ['payments', 'Payments'], ['features', 'Features'], ['attempts', 'Activation Attempts'],
  ['audit', 'Audit Log'], ['settings', 'Settings'],
];
const TITLES = {
  overview: ['Dashboard', 'Overview of your licensing platform'],
  businesses: ['Businesses', 'Manage all registered businesses'],
  licenses: ['Licenses', 'Issue, monitor, and protect access'],
  devices: ['Devices', 'See what is connected right now'],
  plans: ['Plans', 'The commercial rules behind every license'],
  payments: ['Payments', 'Review and reconcile customer payments'],
  features: ['Features', 'Manage product capabilities and entitlements'],
  attempts: ['Activation Attempts', 'Track approved and rejected device activations'],
  audit: ['Audit Log', 'A complete history of administrative activity'],
  settings: ['Settings', 'Configure your licensing workspace'],
};

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem('tylliq_prefs') || '{}');
  } catch {
    return {};
  }
}

const state = {
  view: 'overview', user: null, role: null, data: null, loading: false, booting: true,
  filters: { search: '', status: 'all', plan: 'all', business: 'all' },
  page: 1, pageSize: 10,
  modal: null, modalError: null, modalLookups: null, modalSaving: false, modalEntity: null,
  revealedLicenseKey: null,
  confirm: null,
  toast: null, toastId: 0,
  sidebarOpen: false, notifOpen: false, notifData: null, accountOpen: false,
  businessDetail: null,
  backupModal: false, restoreFile: null,
  prefs: loadPrefs(),
  cache: {},
};

const app = document.querySelector('#app');

// ---------- small render helpers ----------

function statusTone(status) {
  if (['active', 'confirmed', 'approved'].includes(status)) return 'good';
  if (['suspended', 'pending'].includes(status)) return 'warn';
  return 'bad';
}

function statusPill(status) {
  return `<span class="status ${statusTone(status)}"><i></i>${escapeHtml(titleCase(status || 'unknown'))}</span>`;
}

// A device only ever reports clock-integrity fields once it has detected at
// least one backward clock jump (see clockIntegrityFields in
// functions/src/activation.js) - most devices show nothing here at all.
function clockIntegrityBadge(d) {
  if (!d.clockRollbackCount) return '<span class="muted">—</span>';
  const tone = d.clockIntegritySeverity === 'high' ? 'bad' : 'warn';
  const label = d.clockIntegritySeverity === 'high' ? 'Tampering suspected' : 'Low';
  const magnitude = d.lastRollbackMagnitudeMinutes != null
    ? ` · last jump ${formatDuration(d.lastRollbackMagnitudeMinutes)}`
    : '';
  const title = `${d.clockRollbackCount} rollback${d.clockRollbackCount === 1 ? '' : 's'} detected${magnitude}`;
  return `<span class="status ${tone}" title="${escapeHtml(title)}"><i></i>${escapeHtml(label)}</span>`;
}

function formatDuration(minutes) {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function iconButton(action, iconName, label, extra = '') {
  return `<button type="button" class="icon-button row-icon-btn" data-action="${action}" ${extra} title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon(iconName)}</button>`;
}

function indexBy(list, key) {
  const map = new Map();
  (list || []).forEach((item) => map.set(item[key], item));
  return map;
}

function groupBy(list, key) {
  const map = new Map();
  (list || []).forEach((item) => {
    const k = item[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  });
  return map;
}

function showToast(message, tone = 'good') {
  state.toastId += 1;
  const id = state.toastId;
  state.toast = { message, tone };
  renderApp();
  setTimeout(() => {
    if (state.toastId === id) { state.toast = null; renderApp(); }
  }, 4000);
}

function resetListState() {
  state.filters = { search: '', status: 'all', plan: 'all', business: 'all' };
  state.page = 1;
}

// ---------- loading / login ----------

function renderLoading() {
  app.innerHTML = `<main class="loading-screen"><div class="loading-logo">${icon('shield')}</div><h1>Licensing Control Center</h1><p>Loading your administration panel...</p><span class="spinner"></span></main>`;
}

function renderLogin(error = '', info = '') {
  app.innerHTML = `<main class="login-shell">
    <section class="login-panel">
      <div class="login-brand"><span class="brand-mark">${icon('shield')}</span><strong>Licensing Control Center</strong></div>
      <p class="eyebrow">SECURE ADMINISTRATION</p>
      <h1>Licensing operations,<br><em>under control.</em></h1>
      <p class="login-copy">Manage businesses, entitlements, devices, and the audit trail from one secure workspace.</p>
      <form id="login-form" class="login-form" data-form="login">
        <label>Email address<input name="email" type="email" placeholder="admin@company.com" required /></label>
        <label>Password<div class="password-field"><input name="password" type="password" placeholder="Enter your password" required /><button type="button" class="icon-button" data-action="toggle-password" aria-label="Show password">${icon('eyeClosed')}</button></div></label>
        ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ''}
        ${info ? `<p class="form-info">${escapeHtml(info)}</p>` : ''}
        <div class="form-row"><label class="check-label"><input type="checkbox" /> Remember me</label><button class="text-button" type="button" data-action="forgot-password">Forgot password?</button></div>
        <button class="primary-button" type="submit">Sign in <span>↗</span></button>
      </form>
      <p class="login-hint">Authorized administrators only</p>
    </section>
    <aside class="login-art"><div class="art-grid"></div><div class="art-note">02<br><small>LICENSE<br>HEALTH</small></div><div class="art-word">TYLLIQ</div></aside>
  </main>`;
}

// ---------- data loading per view ----------

async function loadViewData(force = false) {
  if (!force && state.cache[state.view]) {
    state.data = state.cache[state.view];
    state.notifOpen = false;
    state.accountOpen = false;
    renderApp();
    return;
  }
  if (force) state.cache = {};
  state.loading = true;
  state.notifOpen = false;
  state.accountOpen = false;
  renderApp();
  try {
    if (state.view === 'overview') {
      state.data = await apiCall('adminGetDashboardStats');
    } else if (state.view === 'settings') {
      state.data = {};
    } else if (state.view === 'businesses') {
      const [b, l, d, p] = await Promise.all([
        apiCall('adminListBusinesses', { limit: 100 }),
        apiCall('adminListLicenses', { limit: 100 }),
        apiCall('adminListDevices', { limit: 200 }),
        apiCall('adminListPlans'),
      ]);
      state.data = { businesses: b.businesses, licenses: l.licenses, devices: d.devices, plans: p.plans };
    } else if (state.view === 'licenses') {
      const [l, b, d, p] = await Promise.all([
        apiCall('adminListLicenses', { limit: 100 }),
        apiCall('adminListBusinesses', { limit: 100 }),
        apiCall('adminListDevices', { limit: 200 }),
        apiCall('adminListPlans'),
      ]);
      state.data = { licenses: l.licenses, businesses: b.businesses, devices: d.devices, plans: p.plans };
    } else if (state.view === 'devices') {
      const [d, b] = await Promise.all([
        apiCall('adminListDevices', { limit: 200 }),
        apiCall('adminListBusinesses', { limit: 100 }),
      ]);
      state.data = { devices: d.devices, businesses: b.businesses };
    } else if (state.view === 'plans') {
      const p = await apiCall('adminListPlans');
      state.data = { plans: p.plans };
    } else if (state.view === 'payments') {
      const [p, b] = await Promise.all([
        apiCall('adminListPayments', { limit: 100 }),
        apiCall('adminListBusinesses', { limit: 100 }),
      ]);
      state.data = { payments: p.payments, businesses: b.businesses };
    } else if (state.view === 'features') {
      const f = await apiCall('adminListFeatures');
      state.data = { features: f.features };
    } else if (state.view === 'audit' || state.view === 'attempts') {
      const e = await apiCall('adminListAuditLog', { limit: 200 });
      const b = await apiCall('adminListBusinesses', { limit: 100 });
      state.data = { events: e.events, businesses: b.businesses };
    }
    state.cache[state.view] = state.data;
  } catch (error) {
    state.data = { error: error.message };
  }
  state.loading = false;
  renderApp();
}

async function loadBusinessDetail(businessId, tab) {
  state.view = 'business-detail';
  state.businessDetail = { id: businessId, tab: tab || 'overview', loading: true, error: null };
  renderApp();
  try {
    const [detail, payments, events, plans] = await Promise.all([
      apiCall('adminGetBusiness', { businessId }),
      apiCall('adminListPayments', { businessId, limit: 100 }),
      apiCall('adminListAuditLog', { businessId, limit: 100 }),
      apiCall('adminListPlans'),
    ]);
    state.businessDetail = {
      id: businessId, tab: state.businessDetail.tab, loading: false, error: null,
      business: detail, licenses: detail.licenses || [], devices: detail.devices || [],
      payments: payments.payments || [], events: events.events || [], plans: plans.plans || [],
    };
  } catch (error) {
    state.businessDetail.loading = false;
    state.businessDetail.error = error.message;
  }
  renderApp();
}

async function loadNotifications() {
  if (state.notifData) return;
  try {
    const result = await apiCall('adminListAuditLog', { limit: 8 });
    state.notifData = result.events;
  } catch {
    state.notifData = [];
  }
  renderApp();
}

// ---------- shell: sidebar / topbar ----------

function sidebarHtml() {
  return `<aside class="sidebar ${state.sidebarOpen ? 'open' : ''}">
    <div class="sidebar-brand"><span class="brand-mark small">${icon('shield')}</span><span>Licensing<br>Control Center</span></div>
    <p class="nav-label">ADMINISTRATION</p>
    <nav>${NAV_ITEMS.map(([id, label]) => `<button type="button" class="nav-item ${state.view === id || (state.view === 'business-detail' && id === 'businesses') ? 'active' : ''}" data-action="nav" data-view="${id}">${navIcon(id)}${label}</button>`).join('')}</nav>
    <div class="sidebar-bottom">
      <div class="connection"><span></span><div><strong>System status</strong><small>Connected</small></div></div>
      <small class="version">Version ${APP_VERSION}</small>
      <button type="button" class="signout" data-action="signout">${icon('logout', 'icon signout-icon')}Sign out</button>
    </div>
  </aside>${state.sidebarOpen ? '<div class="sidebar-backdrop" data-action="close-sidebar"></div>' : ''}`;
}

function notifPanelHtml() {
  if (!state.notifOpen) return '';
  const items = state.notifData;
  const body = items === null ? '<div class="panel-loading">Loading...</div>' : items.length === 0
    ? '<div class="panel-empty">No recent activity.</div>'
    : items.map((item) => `<button type="button" class="notif-row" data-action="open-business" data-id="${escapeHtml(item.businessId || '')}" ${item.businessId ? '' : 'disabled'}>
        <span class="activity-dot"></span>
        <span class="notif-body"><strong>${escapeHtml(titleCase(item.type || 'event'))}</strong><small>${escapeHtml(item.businessId || 'System event')} · ${escapeHtml(formatRelative(item.at))}</small></span>
      </button>`).join('');
  return `<div class="dropdown-backdrop" data-action="close-panels"></div><div class="dropdown notif-dropdown"><div class="dropdown-heading">Recent activity</div>${body}<button type="button" class="dropdown-footer" data-action="nav" data-view="audit">View audit log</button></div>`;
}

function accountPanelHtml() {
  if (!state.accountOpen) return '';
  return `<div class="dropdown-backdrop" data-action="close-panels"></div><div class="dropdown account-dropdown">
    <div class="dropdown-heading">${escapeHtml(state.user?.email || '')}</div>
    <p class="account-role">${escapeHtml(state.role ? titleCase(state.role) : 'Administrator')}</p>
    <button type="button" class="dropdown-item" data-action="nav" data-view="settings">${icon('settings')}Settings</button>
    <button type="button" class="dropdown-item" data-action="signout">${icon('logout')}Sign out</button>
  </div>`;
}

function topbarHtml() {
  return `<header class="topbar">
    <button type="button" class="icon-button hamburger" data-action="toggle-sidebar" aria-label="Open menu">${icon('menu')}</button>
    <form class="global-search" data-form="global-search"><span>${icon('search')}</span><input name="q" placeholder="Search businesses, licenses, devices..." /></form>
    <div class="top-actions">
      <div class="dropdown-anchor">
        <button type="button" class="icon-button" data-action="toggle-notifications" title="Notifications">${icon('bell')}</button>
        ${notifPanelHtml()}
      </div>
      <button type="button" class="icon-button" data-action="refresh" title="Refresh">${icon('refresh')}</button>
      <div class="dropdown-anchor">
        <button type="button" class="admin-menu" data-action="toggle-account"><span class="avatar">${initials(state.user?.email)}</span><span class="admin-label">Admin</span>${icon('chevronDown', 'icon chevron-icon')}</button>
        ${accountPanelHtml()}
      </div>
    </div>
  </header>`;
}

function pageHeadingHtml() {
  const title = TITLES[state.view];
  if (!title) return '';
  return `<div class="page-heading"><div><p class="breadcrumb">CONTROL CENTER / ${state.view.toUpperCase()}</p><h1>${title[0]}</h1><p class="subtitle">${title[1]}</p></div></div>`;
}

// ---------- dashboard ----------

function statCard({ label, value, detail, accent, goto, gotoStatus }) {
  const badge = accent === 'green' ? 'check' : accent === 'rose' ? 'alert' : accent === 'blue' ? 'attempts' : 'clock';
  return `<button type="button" class="stat-card ${accent}" data-action="nav" data-view="${goto}" ${gotoStatus ? `data-status="${gotoStatus}"` : ''}>
    <div class="stat-heading"><p>${escapeHtml(label)}</p><span class="metric-icon">${icon(badge)}</span></div>
    <strong>${formatNumber(value)}</strong><span>${escapeHtml(detail)}</span>
  </button>`;
}

function healthPercent(licenses) {
  const total = (licenses.active || 0) + (licenses.suspended || 0) + (licenses.revoked || 0) + (licenses.expired || 0);
  return total ? Math.round((licenses.active || 0) / total * 100) : 0;
}

function activityChart(activity) {
  if (!activity.length) return '<div class="chart-empty">Chart data will appear here as events happen.</div>';
  const ordered = [...activity].sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  let rejectedTotal = 0;
  const rejected = ordered.map((item) => { if (item.type === 'activation_rejected') rejectedTotal += 1; return rejectedTotal; });
  const totals = ordered.map((_, index) => index + 1);
  const max = Math.max(totals.length ? totals[totals.length - 1] : 0, rejectedTotal, 1);
  const points = (values) => values.map((value, index) => `${(index / Math.max(values.length - 1, 1)) * 100},${36 - (value / max) * 30}`).join(' ');
  return `<svg class="activity-chart" viewBox="0 0 100 40" preserveAspectRatio="none" aria-label="Activity events chart"><polyline class="chart-line activity-line" points="${points(totals)}" /><polyline class="chart-line rejected-line" points="${points(rejected)}" /></svg>`;
}

function activityIcon(type) {
  if (type?.includes('device')) return 'devices';
  if (type?.includes('license')) return 'licenses';
  if (type?.includes('payment')) return 'payments';
  if (type?.includes('business')) return 'businesses';
  if (type?.includes('rejected')) return 'alert';
  return 'audit';
}

function overviewContent() {
  const data = state.data || {};
  if (state.loading) return '<div class="loading">Loading control center<span>...</span></div>';
  if (data.error) return `<div class="empty-state"><strong>Could not load the dashboard</strong><p>${escapeHtml(data.error)}</p><button type="button" class="secondary-button" data-action="refresh">Retry</button></div>`;
  const businesses = data.businesses || {};
  const licenses = data.licenses || {};
  const devices = data.devices || {};
  const activity = data.recentActivity || [];
  const failed = data.failedActivationsLast20 || [];
  return `<div class="stats-grid">
    ${statCard({ label: 'Total Businesses', value: businesses.total, detail: 'all registered businesses', accent: 'orange', goto: 'businesses' })}
    ${statCard({ label: 'Active Licenses', value: licenses.active, detail: 'currently active', accent: 'green', goto: 'licenses', gotoStatus: 'active' })}
    ${statCard({ label: 'Active Devices', value: devices.active, detail: 'registered and active', accent: 'blue', goto: 'devices', gotoStatus: 'active' })}
    ${statCard({ label: 'Expiring Soon', value: licenses.expiringSoon, detail: 'within the next 7 days', accent: 'orange', goto: 'licenses', gotoStatus: 'expiring_soon' })}
    ${statCard({ label: 'Expired Licenses', value: licenses.expired, detail: 'require renewal', accent: 'rose', goto: 'licenses', gotoStatus: 'expired' })}
    ${statCard({ label: 'Total Devices', value: devices.total, detail: 'ever registered', accent: 'blue', goto: 'devices' })}
    ${statCard({ label: 'Failed Activations', value: failed.length, detail: 'recent rejected attempts', accent: 'rose', goto: 'attempts', gotoStatus: 'rejected' })}
    ${statCard({ label: 'Suspended Licenses', value: licenses.suspended, detail: 'temporarily disabled', accent: 'rose', goto: 'licenses', gotoStatus: 'suspended' })}
  </div>
  <section class="panel chart-panel"><div class="panel-heading"><div><p class="eyebrow">LICENSE ACTIVITY</p><h2>Licensing activity over time</h2></div><span class="record-count">${activity.length ? 'Live records' : 'No data yet'}</span></div><div class="chart-placeholder"><div class="chart-y-axis"><span>—</span><span>—</span><span>—</span><span>—</span></div><div class="chart-grid"><span></span><span></span><span></span><span></span>${activityChart(activity)}</div></div><div class="chart-legend"><span><i class="dot green-dot"></i>Activity events</span><span><i class="dot red-dot"></i>Rejected activations</span></div></section>
  <section class="content-grid">
    <article class="panel activity-panel"><div class="panel-heading"><div><p class="eyebrow">LIVE FEED</p><h2>Recent activity</h2></div><button type="button" class="icon-button" data-action="refresh" title="Refresh activity">${icon('refresh')}</button></div>
      ${activity.length ? `<div class="activity-list">${activity.map((item) => `<button type="button" class="activity-row ${item.businessId ? 'clickable' : ''}" data-action="open-business" data-id="${escapeHtml(item.businessId || '')}" ${item.businessId ? '' : 'disabled'}><span class="activity-icon">${icon(activityIcon(item.type))}</span><div><strong>${escapeHtml(titleCase(item.type || 'event'))}</strong><small>${escapeHtml(item.businessId || 'System event')}</small></div><time>${escapeHtml(formatRelative(item.at))}</time></button>`).join('')}</div>` : '<div class="blank"><strong>No activity recorded yet</strong><small>Activity will appear here as your platform is used.</small></div>'}
    </article>
    <article class="panel health-panel"><p class="eyebrow">LICENSE HEALTH</p><h2>Portfolio pulse</h2><div class="health-ring" style="--health:${healthPercent(licenses)}%"><strong>${formatNumber(licenses.active)}</strong><span>active</span></div><div class="legend"><button type="button" data-action="nav" data-view="licenses" data-status="active"><i class="dot green-dot"></i>Active <b>${formatNumber(licenses.active)}</b></button><button type="button" data-action="nav" data-view="licenses" data-status="suspended"><i class="dot yellow-dot"></i>Suspended <b>${formatNumber(licenses.suspended)}</b></button><button type="button" data-action="nav" data-view="licenses" data-status="revoked"><i class="dot red-dot"></i>Revoked <b>${formatNumber(licenses.revoked)}</b></button><button type="button" data-action="nav" data-view="licenses" data-status="expired"><i class="dot blue-dot"></i>Expired <b>${formatNumber(licenses.expired)}</b></button></div></article>
  </section>`;
}

// ---------- generic table pieces ----------

function paginationControls(totalRows, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const from = totalRows === 0 ? 0 : (clampedPage - 1) * pageSize + 1;
  const to = Math.min(totalRows, clampedPage * pageSize);
  let pageButtons = '';
  const pushBtn = (n) => `<button type="button" class="page-btn ${n === clampedPage ? 'active' : ''}" data-action="page" data-page="${n}">${n}</button>`;
  if (totalPages <= 7) {
    for (let n = 1; n <= totalPages; n += 1) pageButtons += pushBtn(n);
  } else {
    const nums = new Set([1, 2, totalPages - 1, totalPages, clampedPage - 1, clampedPage, clampedPage + 1]);
    let prev = 0;
    for (let n = 1; n <= totalPages; n += 1) {
      if (!nums.has(n) || n < 1 || n > totalPages) continue;
      if (prev && n - prev > 1) pageButtons += '<span class="page-ellipsis">…</span>';
      pageButtons += pushBtn(n);
      prev = n;
    }
  }
  return `<div class="table-footer">
    <span>Showing ${from}-${to} of ${totalRows} records</span>
    <span class="pager">Rows per page <select data-action="page-size">${[10, 25, 50].map((n) => `<option value="${n}" ${n === pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <button type="button" class="page-nav" data-action="page" data-page="${Math.max(1, clampedPage - 1)}" ${clampedPage === 1 ? 'disabled' : ''}>‹</button>
      ${pageButtons}
      <button type="button" class="page-nav" data-action="page" data-page="${Math.min(totalPages, clampedPage + 1)}" ${clampedPage === totalPages ? 'disabled' : ''}>›</button>
    </span>
  </div>`;
}

function selectFilter(action, value, options) {
  return `<select data-action="${action}">${options.map(([v, label]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`;
}

function matchesSearch(row, term) {
  if (!term) return true;
  return JSON.stringify(row).toLowerCase().includes(term.toLowerCase());
}

function isLicenseExpired(license) {
  if (license.status === 'expired') return true;
  if (license.status !== 'active' || !license.expiresAt) return false;
  return new Date(license.expiresAt).getTime() <= Date.now();
}

function isLicenseExpiringSoon(license) {
  if (license.status !== 'active' || !license.expiresAt || isLicenseExpired(license)) return false;
  return new Date(license.expiresAt).getTime() <= Date.now() + 7 * 86400000;
}

// ---------- Businesses ----------

function enrichBusinesses(data) {
  const licensesByBiz = groupBy(data.licenses, 'businessId');
  const devicesByBiz = groupBy(data.devices, 'businessId');
  const planById = indexBy(data.plans, 'planId');
  return (data.businesses || []).map((b) => {
    const licenses = licensesByBiz.get(b.businessId) || [];
    const license = licenses.find((l) => l.status === 'active') || licenses[0] || null;
    const plan = license ? planById.get(license.planId) : null;
    const devices = devicesByBiz.get(b.businessId) || [];
    const activeDevices = devices.filter((d) => d.status === 'active').length;
    const lastSeen = devices.map((d) => d.lastSeenAt).filter(Boolean).sort().pop();
    const lastActivity = [b.updatedAt, license?.updatedAt, lastSeen].filter(Boolean).sort().pop();
    return { ...b, _license: license, _planName: plan?.name || license?.planId || '—', _activeDevices: activeDevices, _maxDevices: license?.maxDevices ?? null, _lastActivity: lastActivity };
  });
}

function businessesView() {
  if (state.loading) return '<div class="loading">Loading businesses<span>...</span></div>';
  if (!state.data || state.data.error) return `<div class="empty-state"><strong>${escapeHtml(state.data?.error || 'No data loaded')}</strong><button type="button" class="secondary-button" data-action="refresh">Retry</button></div>`;
  const rows = enrichBusinesses(state.data);
  const plans = state.data.plans || [];
  let filtered = rows.filter((r) => matchesSearch(r, state.filters.search));
  if (state.filters.status !== 'all') filtered = filtered.filter((r) => r.status === state.filters.status);
  if (state.filters.plan !== 'all') filtered = filtered.filter((r) => r._license?.planId === state.filters.plan);
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  const page = Math.min(state.page, totalPages);
  const pageRows = filtered.slice((page - 1) * state.pageSize, page * state.pageSize);
  const body = pageRows.length ? pageRows.map((b) => `<tr class="clickable-row" data-action="open-business" data-id="${escapeHtml(b.businessId)}">
    <td><strong>${escapeHtml(b.name)}</strong>${b.country ? `<br><small class="muted">${escapeHtml(b.country)}</small>` : ''}</td>
    <td class="mono">${escapeHtml(b.businessId.slice(0, 8))}</td>
    <td>${escapeHtml(b._planName)}</td>
    <td class="mono">${b._license ? escapeHtml(b._license.licenseId.slice(0, 8)) : '—'}</td>
    <td>${b._maxDevices !== null ? `${b._activeDevices}/${b._maxDevices}` : '—'}</td>
    <td>${statusPill(b.status)}</td>
    <td>${b._license ? escapeHtml(formatDate(b._license.expiresAt)) : '—'}</td>
    <td>${escapeHtml(formatRelative(b._lastActivity))}</td>
    <td class="row-actions">
      ${iconButton('open-business', 'eyeOpen', 'View business', `data-id="${escapeHtml(b.businessId)}"`)}
      ${iconButton('toggle-business-status', 'power', b.status === 'active' ? 'Suspend business' : 'Activate business', `data-id="${escapeHtml(b.businessId)}" data-status="${b.status}" data-name="${escapeHtml(b.name)}"`)}
    </td>
  </tr>`).join('') : `<tr><td colspan="9" class="blank"><span class="empty-icon">${icon('businesses')}</span><strong>No businesses found</strong><small>Try adjusting your filters, or add a new business.</small></td></tr>`;
  return `<section class="panel table-panel">
    <div class="panel-heading"><div><p class="eyebrow">DIRECTORY</p><h2>Businesses</h2></div><div class="panel-actions"><button type="button" class="primary-button compact-button" data-action="open-modal" data-kind="business">${icon('plus')}Add Business</button></div></div>
    <div class="table-tools">
      <input class="table-search" data-action="search" value="${escapeHtml(state.filters.search)}" placeholder="Search businesses..." />
      ${selectFilter('filter-plan', state.filters.plan, [['all', 'All Plans'], ...plans.map((p) => [p.planId, p.name])])}
      ${selectFilter('filter-status', state.filters.status, [['all', 'All Statuses'], ['active', 'Active'], ['suspended', 'Suspended']])}
      <button type="button" class="secondary-button filter-button" data-action="filter-reset">${icon('filter')}Reset</button>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Business</th><th>Business ID</th><th>Plan</th><th>License</th><th>Devices</th><th>Status</th><th>Expiry</th><th>Last Activity</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>
    ${paginationControls(filtered.length, page, state.pageSize)}
  </section>`;
}

// ---------- Licenses ----------

function enrichLicenses(data) {
  const businessById = indexBy(data.businesses, 'businessId');
  const planById = indexBy(data.plans, 'planId');
  const devicesByLicense = groupBy(data.devices, 'licenseId');
  return (data.licenses || []).map((l) => {
    const devices = devicesByLicense.get(l.licenseId) || [];
    const activeDevices = devices.filter((d) => d.status === 'active').length;
    return { ...l, _businessName: businessById.get(l.businessId)?.name || l.businessId, _planName: planById.get(l.planId)?.name || l.planId, _activeDevices: activeDevices };
  });
}

function licensesView() {
  if (state.loading) return '<div class="loading">Loading licenses<span>...</span></div>';
  if (!state.data || state.data.error) return `<div class="empty-state"><strong>${escapeHtml(state.data?.error || 'No data loaded')}</strong><button type="button" class="secondary-button" data-action="refresh">Retry</button></div>`;
  const rows = enrichLicenses(state.data);
  const plans = state.data.plans || [];
  let filtered = rows.filter((r) => matchesSearch(r, state.filters.search));
  if (state.filters.plan !== 'all') filtered = filtered.filter((r) => r.planId === state.filters.plan);
  if (state.filters.status === 'expiring_soon') filtered = filtered.filter(isLicenseExpiringSoon);
  else if (state.filters.status === 'expired') filtered = filtered.filter(isLicenseExpired);
  else if (state.filters.status !== 'all') filtered = filtered.filter((r) => r.status === state.filters.status && !isLicenseExpired(r));
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  const page = Math.min(state.page, totalPages);
  const pageRows = filtered.slice((page - 1) * state.pageSize, page * state.pageSize);
  const body = pageRows.length ? pageRows.map((l) => `<tr class="clickable-row" data-action="manage-license" data-id="${escapeHtml(l.licenseId)}">
    <td class="mono">LIC-${escapeHtml(l.licenseId.slice(0, 6).toUpperCase())}</td>
    <td>${escapeHtml(l._businessName)}</td>
    <td>${escapeHtml(l._planName)}</td>
    <td>${isLicenseExpired(l) ? statusPill('expired') : isLicenseExpiringSoon(l) ? '<span class="status warn"><i></i>Expiring soon</span>' : statusPill(l.status)}</td>
    <td>${l._activeDevices}/${formatNumber(l.maxDevices)}</td>
    <td>${escapeHtml(formatDate(l.expiresAt))}</td>
    <td class="row-actions">${iconButton('manage-license', 'pencil', 'Manage license', `data-id="${escapeHtml(l.licenseId)}"`)}</td>
  </tr>`).join('') : `<tr><td colspan="7" class="blank"><span class="empty-icon">${icon('licenses')}</span><strong>No licenses found</strong><small>Try adjusting your filters, or issue a new license.</small></td></tr>`;
  return `<section class="panel table-panel">
    <div class="panel-heading"><div><p class="eyebrow">DIRECTORY</p><h2>Licenses</h2></div><div class="panel-actions"><button type="button" class="primary-button compact-button" data-action="open-modal" data-kind="license">${icon('plus')}Issue License</button></div></div>
    <div class="table-tools">
      <input class="table-search" data-action="search" value="${escapeHtml(state.filters.search)}" placeholder="Search licenses..." />
      ${selectFilter('filter-plan', state.filters.plan, [['all', 'All Plans'], ...plans.map((p) => [p.planId, p.name])])}
      ${selectFilter('filter-status', state.filters.status, [['all', 'All Statuses'], ['active', 'Active'], ['expiring_soon', 'Expiring soon'], ['suspended', 'Suspended'], ['revoked', 'Revoked'], ['expired', 'Expired']])}
      <button type="button" class="secondary-button filter-button" data-action="filter-reset">${icon('filter')}Reset</button>
    </div>
    <div class="table-wrap"><table><thead><tr><th>License ID</th><th>Business</th><th>Plan</th><th>Status</th><th>Devices</th><th>Expiry</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>
    ${paginationControls(filtered.length, page, state.pageSize)}
  </section>`;
}

// ---------- Devices ----------

function enrichDevices(data) {
  const businessById = indexBy(data.businesses, 'businessId');
  return (data.devices || []).map((d) => ({ ...d, _businessName: businessById.get(d.businessId)?.name || d.businessId }));
}

function devicesView() {
  if (state.loading) return '<div class="loading">Loading devices<span>...</span></div>';
  if (!state.data || state.data.error) return `<div class="empty-state"><strong>${escapeHtml(state.data?.error || 'No data loaded')}</strong><button type="button" class="secondary-button" data-action="refresh">Retry</button></div>`;
  const rows = enrichDevices(state.data);
  const businesses = state.data.businesses || [];
  let filtered = rows.filter((r) => matchesSearch(r, state.filters.search));
  if (state.filters.status !== 'all') filtered = filtered.filter((r) => r.status === state.filters.status);
  if (state.filters.business !== 'all') filtered = filtered.filter((r) => r.businessId === state.filters.business);
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  const page = Math.min(state.page, totalPages);
  const pageRows = filtered.slice((page - 1) * state.pageSize, page * state.pageSize);
  const body = pageRows.length ? pageRows.map((d) => `<tr class="clickable-row" data-action="open-business" data-id="${escapeHtml(d.businessId)}">
    <td class="mono">${escapeHtml(d.deviceId.slice(0, 10))}</td>
    <td>${escapeHtml(d._businessName)}</td>
    <td>${escapeHtml(d.deviceLabel || '—')}</td>
    <td>${escapeHtml(d.platform || '—')}</td>
    <td>${statusPill(d.status)}</td>
    <td>${clockIntegrityBadge(d)}</td>
    <td>${escapeHtml(formatRelative(d.lastSeenAt))}</td>
    <td class="row-actions">${d.status === 'active' ? iconButton('deactivate-device', 'power', 'Deactivate device', `data-id="${escapeHtml(d.deviceId)}" data-business="${escapeHtml(d._businessName)}"`) : ''}</td>
  </tr>`).join('') : `<tr><td colspan="8" class="blank"><span class="empty-icon">${icon('devices')}</span><strong>No devices found</strong><small>Devices appear here once a business activates the app.</small></td></tr>`;
  return `<section class="panel table-panel">
    <div class="panel-heading"><div><p class="eyebrow">DIRECTORY</p><h2>Devices</h2></div><div class="panel-actions"><span class="record-count">${filtered.length} records</span></div></div>
    <div class="table-tools">
      <input class="table-search" data-action="search" value="${escapeHtml(state.filters.search)}" placeholder="Search devices..." />
      ${selectFilter('filter-business', state.filters.business, [['all', 'All Businesses'], ...businesses.map((b) => [b.businessId, b.name])])}
      ${selectFilter('filter-status', state.filters.status, [['all', 'All Statuses'], ['active', 'Active'], ['deactivated', 'Deactivated']])}
      <button type="button" class="secondary-button filter-button" data-action="filter-reset">${icon('filter')}Reset</button>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Device ID</th><th>Business</th><th>Device Name</th><th>Platform</th><th>Status</th><th>Clock</th><th>Last Seen</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>
    ${paginationControls(filtered.length, page, state.pageSize)}
  </section>`;
}

// ---------- Plans ----------

function plansView() {
  if (state.loading) return '<div class="loading">Loading plans<span>...</span></div>';
  if (!state.data || state.data.error) return `<div class="empty-state"><strong>${escapeHtml(state.data?.error || 'No data loaded')}</strong><button type="button" class="secondary-button" data-action="refresh">Retry</button></div>`;
  const rows = (state.data.plans || []).filter((r) => matchesSearch(r, state.filters.search));
  const body = rows.length ? rows.map((p) => `<tr class="clickable-row" data-action="open-modal" data-kind="plan-edit" data-id="${escapeHtml(p.planId)}">
    <td><strong>${escapeHtml(p.name)}</strong></td>
    <td>${escapeHtml(formatMoney(p.priceCents, p.currency))}<small class="muted">/${escapeHtml(p.billingPeriod || 'month')}</small></td>
    <td>${formatNumber(p.maxDevices)}</td>
    <td>${(p.features || []).length ? `<span class="feature-badge">${p.features.length} feature${p.features.length === 1 ? '' : 's'}</span>` : '<span class="muted">None</span>'}</td>
    <td>${statusPill(p.status || 'active')}</td>
    <td class="row-actions">${iconButton('open-modal', 'pencil', 'Edit plan', `data-kind="plan-edit" data-id="${escapeHtml(p.planId)}"`)}</td>
  </tr>`).join('') : `<tr><td colspan="6" class="blank"><span class="empty-icon">${icon('plans')}</span><strong>No plans yet</strong><small>Add a plan to start issuing licenses.</small></td></tr>`;
  return `<section class="panel table-panel">
    <div class="panel-heading"><div><p class="eyebrow">DIRECTORY</p><h2>Plans</h2></div><div class="panel-actions"><button type="button" class="primary-button compact-button" data-action="open-modal" data-kind="plan">${icon('plus')}Add Plan</button></div></div>
    <div class="table-tools"><input class="table-search" data-action="search" value="${escapeHtml(state.filters.search)}" placeholder="Search plans..." /></div>
    <div class="table-wrap"><table><thead><tr><th>Plan Name</th><th>Price</th><th>Devices</th><th>Features</th><th>Status</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>
  </section>`;
}

// ---------- Payments ----------

function enrichPayments(data) {
  const businessById = indexBy(data.businesses, 'businessId');
  return (data.payments || []).map((p) => ({ ...p, _businessName: businessById.get(p.businessId)?.name || p.businessId }));
}

function paymentActions(p) {
  if (p.status === 'pending') {
    return iconButton('set-payment-status', 'check', 'Confirm payment', `data-id="${escapeHtml(p.paymentId)}" data-status="confirmed"`)
      + iconButton('set-payment-status', 'close', 'Reject payment', `data-id="${escapeHtml(p.paymentId)}" data-status="rejected"`);
  }
  if (p.status === 'confirmed') {
    return iconButton('set-payment-status', 'refresh', 'Refund payment', `data-id="${escapeHtml(p.paymentId)}" data-status="refunded"`);
  }
  return '';
}

function paymentsView() {
  if (state.loading) return '<div class="loading">Loading payments<span>...</span></div>';
  if (!state.data || state.data.error) return `<div class="empty-state"><strong>${escapeHtml(state.data?.error || 'No data loaded')}</strong><button type="button" class="secondary-button" data-action="refresh">Retry</button></div>`;
  const rows = enrichPayments(state.data);
  let filtered = rows.filter((r) => matchesSearch(r, state.filters.search));
  if (state.filters.status !== 'all') filtered = filtered.filter((r) => r.status === state.filters.status);
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  const page = Math.min(state.page, totalPages);
  const pageRows = filtered.slice((page - 1) * state.pageSize, page * state.pageSize);
  const body = pageRows.length ? pageRows.map((p) => `<tr class="clickable-row" data-action="open-business" data-id="${escapeHtml(p.businessId)}">
    <td>${escapeHtml(formatDateTime(p.createdAt))}</td>
    <td>${escapeHtml(p._businessName)}</td>
    <td><strong>${escapeHtml(formatMoney(p.amountCents, p.currency))}</strong></td>
    <td>${escapeHtml(titleCase(p.method || '—'))}</td>
    <td>${statusPill(p.status)}</td>
    <td class="row-actions">${paymentActions(p)}</td>
  </tr>`).join('') : `<tr><td colspan="6" class="blank"><span class="empty-icon">${icon('payments')}</span><strong>No payments found</strong><small>Recorded payments will appear here.</small></td></tr>`;
  return `<section class="panel table-panel">
    <div class="panel-heading"><div><p class="eyebrow">DIRECTORY</p><h2>Payments</h2></div><div class="panel-actions"><button type="button" class="primary-button compact-button" data-action="open-modal" data-kind="payment">${icon('plus')}Record Payment</button></div></div>
    <div class="table-tools">
      <input class="table-search" data-action="search" value="${escapeHtml(state.filters.search)}" placeholder="Search payments..." />
      ${selectFilter('filter-status', state.filters.status, [['all', 'All Statuses'], ['pending', 'Pending'], ['confirmed', 'Confirmed'], ['rejected', 'Rejected'], ['refunded', 'Refunded']])}
      <button type="button" class="secondary-button filter-button" data-action="filter-reset">${icon('filter')}Reset</button>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Business</th><th>Amount</th><th>Method</th><th>Status</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>
    ${paginationControls(filtered.length, page, state.pageSize)}
  </section>`;
}

// ---------- Features ----------

function featuresView() {
  if (state.loading) return '<div class="loading">Loading features<span>...</span></div>';
  if (!state.data || state.data.error) return `<div class="empty-state"><strong>${escapeHtml(state.data?.error || 'No data loaded')}</strong><button type="button" class="secondary-button" data-action="refresh">Retry</button></div>`;
  const rows = (state.data.features || []).filter((r) => matchesSearch(r, state.filters.search));
  const body = rows.length ? rows.map((f) => `<tr class="clickable-row" data-action="open-modal" data-kind="feature-edit" data-id="${escapeHtml(f.key)}">
    <td class="mono">${escapeHtml(f.key)}</td>
    <td>${escapeHtml(f.label)}</td>
    <td>${escapeHtml(f.productId || '—')}</td>
    <td>${escapeHtml(formatDate(f.createdAt))}</td>
    <td class="row-actions">${iconButton('open-modal', 'pencil', 'Edit feature', `data-kind="feature-edit" data-id="${escapeHtml(f.key)}"`)}</td>
  </tr>`).join('') : `<tr><td colspan="5" class="blank"><span class="empty-icon">${icon('features')}</span><strong>No features yet</strong><small>Click "Add default features" for a ready-made starter set, or add your own.</small></td></tr>`;
  return `<section class="panel table-panel">
    <div class="panel-heading"><div><p class="eyebrow">DIRECTORY</p><h2>Features</h2></div><div class="panel-actions"><button type="button" class="secondary-button compact-button" data-action="seed-default-features">Add default features</button><button type="button" class="primary-button compact-button" data-action="open-modal" data-kind="feature">${icon('plus')}Add Feature</button></div></div>
    <div class="table-tools"><input class="table-search" data-action="search" value="${escapeHtml(state.filters.search)}" placeholder="Search features..." /></div>
    <div class="table-wrap"><table><thead><tr><th>Key</th><th>Label</th><th>Product</th><th>Created</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>
  </section>`;
}

// ---------- Audit / Activation Attempts ----------

function auditView(isAttempts) {
  if (state.loading) return '<div class="loading">Loading records<span>...</span></div>';
  if (!state.data || state.data.error) return `<div class="empty-state"><strong>${escapeHtml(state.data?.error || 'No data loaded')}</strong><button type="button" class="secondary-button" data-action="refresh">Retry</button></div>`;
  const businessById = indexBy(state.data.businesses, 'businessId');
  let rows = state.data.events || [];
  if (isAttempts) rows = rows.filter((r) => ['activation_approved', 'activation_rejected'].includes(r.type));
  if (state.filters.status === 'rejected') rows = rows.filter((r) => r.type === 'activation_rejected');
  rows = rows.filter((r) => matchesSearch(r, state.filters.search));
  const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  const page = Math.min(state.page, totalPages);
  const pageRows = rows.slice((page - 1) * state.pageSize, page * state.pageSize);
  const body = pageRows.length ? pageRows.map((e) => `<tr>
    <td>${e.type === 'activation_rejected' ? '<span class="status bad"><i></i>Rejected</span>' : e.type === 'activation_approved' ? '<span class="status good"><i></i>Approved</span>' : escapeHtml(titleCase(e.type))}</td>
    <td>${e.businessId ? `<button type="button" class="link-chip" data-action="open-business" data-id="${escapeHtml(e.businessId)}">${escapeHtml(e.businessId.slice(0, 8))}</button>` : '—'}</td>
    <td class="mono">${e.licenseId ? escapeHtml(e.licenseId.slice(0, 8)) : '—'}</td>
    <td class="mono">${e.deviceId ? escapeHtml(e.deviceId.slice(0, 10)) : '—'}</td>
    <td>${e.meta?.reason ? escapeHtml(titleCase(e.meta.reason)) : '—'}</td>
    <td>${escapeHtml(formatDateTime(e.at))}</td>
  </tr>`).join('') : `<tr><td colspan="6" class="blank"><span class="empty-icon">${icon('audit')}</span><strong>No records found</strong><small>Events will appear here as they happen.</small></td></tr>`;
  return `<section class="panel table-panel">
    <div class="panel-heading"><div><p class="eyebrow">DIRECTORY</p><h2>${isAttempts ? 'Activation Attempts' : 'Audit Log'}</h2></div><span class="record-count">${rows.length} records</span></div>
    <div class="table-tools"><input class="table-search" data-action="search" value="${escapeHtml(state.filters.search)}" placeholder="Search ${isAttempts ? 'attempts' : 'audit log'}..." /><button type="button" class="secondary-button filter-button" data-action="filter-reset">${icon('filter')}Reset</button></div>
    <div class="table-wrap"><table><thead><tr><th>Event</th><th>Business</th><th>License</th><th>Device</th><th>Reason</th><th>At</th></tr></thead><tbody>${body}</tbody></table></div>
    ${paginationControls(rows.length, page, state.pageSize)}
  </section>`;
}

// ---------- Business detail ----------

function businessDetailView() {
  const bd = state.businessDetail;
  if (!bd) return '';
  if (bd.loading) return '<div class="loading">Loading business<span>...</span></div>';
  if (bd.error) return `<div class="empty-state"><strong>Could not load this business</strong><p>${escapeHtml(bd.error)}</p><button type="button" class="secondary-button" data-action="nav" data-view="businesses">Back to Businesses</button></div>`;
  const business = bd.business;
  const activeLicense = bd.licenses.find((l) => l.status === 'active') || bd.licenses[0] || null;
  const planById = indexBy(bd.plans, 'planId');
  const plan = activeLicense ? planById.get(activeLicense.planId) : null;
  const activeDevices = bd.devices.filter((d) => d.status === 'active').length;
  const totalSalesCents = bd.payments.filter((p) => p.status === 'confirmed').reduce((sum, p) => sum + (p.amountCents || 0), 0);

  const tabs = [['overview', 'Overview'], ['licenses', `Licenses (${bd.licenses.length})`], ['devices', `Devices (${bd.devices.length})`], ['payments', `Payments (${bd.payments.length})`], ['activity', 'Activity']];
  const tabBar = `<div class="detail-tabs">${tabs.map(([id, label]) => `<button type="button" class="detail-tab ${bd.tab === id ? 'active' : ''}" data-action="detail-tab" data-tab="${id}">${label}</button>`).join('')}</div>`;

  let body = '';
  if (bd.tab === 'overview') {
    body = `<div class="detail-columns">
      <article class="panel settings-card"><p class="eyebrow">BUSINESS INFORMATION</p><h2>Overview</h2>
        <div class="kv-row"><span>Business Name</span><strong>${escapeHtml(business.name)}</strong></div>
        <div class="kv-row"><span>Business ID</span><strong class="mono">${escapeHtml(business.businessId)}</strong></div>
        <div class="kv-row"><span>Contact Email</span><strong>${escapeHtml(business.contactEmail || '—')}</strong></div>
        <div class="kv-row"><span>Country</span><strong>${escapeHtml(business.country || '—')}</strong></div>
        <div class="kv-row"><span>Registered</span><strong>${escapeHtml(formatDate(business.createdAt))}</strong></div>
      </article>
      <article class="panel settings-card"><p class="eyebrow">PLAN &amp; LICENSE</p><h2>${activeLicense ? 'Active entitlement' : 'No license yet'}</h2>
        ${activeLicense ? `
        <div class="kv-row"><span>Plan</span><strong>${escapeHtml(plan?.name || activeLicense.planId)}</strong></div>
        <div class="id-field"><span>License ID</span><strong class="mono">${escapeHtml(activeLicense.licenseId)}</strong><button type="button" class="icon-button" data-action="copy-text" data-value="${escapeHtml(activeLicense.licenseId)}" title="Copy license ID">${icon('copy')}</button></div>
        <div class="kv-row"><span>Status</span>${statusPill(activeLicense.status)}</div>
        <div class="kv-row"><span>Expiry Date</span><strong>${escapeHtml(formatDate(activeLicense.expiresAt))}</strong></div>
        <div class="kv-row"><span>Max Devices</span><strong>${formatNumber(activeLicense.maxDevices)}</strong></div>
        <button type="button" class="secondary-button" data-action="manage-license" data-id="${escapeHtml(activeLicense.licenseId)}">Manage license</button>
        ` : `<p class="modal-copy">This business has no license yet.</p><button type="button" class="primary-button" data-action="open-modal" data-kind="license" data-business="${escapeHtml(business.businessId)}">${icon('plus')}Issue License</button>`}
      </article>
    </div>
    <div class="stat-row">
      <article class="mini-stat"><span>Devices</span><strong>${activeDevices}/${activeLicense ? formatNumber(activeLicense.maxDevices) : '—'}</strong></article>
      <article class="mini-stat"><span>Licenses</span><strong>${bd.licenses.length}</strong></article>
      <article class="mini-stat"><span>Total Sales</span><strong>${escapeHtml(formatMoney(totalSalesCents, 'USD'))}</strong></article>
    </div>
    <article class="panel activity-panel"><div class="panel-heading"><div><p class="eyebrow">LIVE FEED</p><h2>Recent activity</h2></div></div>
      ${bd.events.length ? `<div class="activity-list">${bd.events.slice(0, 8).map((e) => `<div class="activity-row"><span class="activity-icon">${icon(activityIcon(e.type))}</span><div><strong>${escapeHtml(titleCase(e.type))}</strong><small>${e.meta?.reason ? escapeHtml(titleCase(e.meta.reason)) : ''}</small></div><time>${escapeHtml(formatRelative(e.at))}</time></div>`).join('')}</div>` : '<div class="blank"><strong>No activity yet</strong></div>'}
    </article>`;
  } else if (bd.tab === 'licenses') {
    body = `<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">LICENSES</p><h2>All licenses</h2></div><button type="button" class="primary-button compact-button" data-action="open-modal" data-kind="license" data-business="${escapeHtml(business.businessId)}">${icon('plus')}Issue License</button></div>
      <div class="table-wrap"><table><thead><tr><th>License ID</th><th>Plan</th><th>Status</th><th>Devices</th><th>Expiry</th><th>Actions</th></tr></thead><tbody>
        ${bd.licenses.length ? bd.licenses.map((l) => `<tr><td class="mono">${escapeHtml(l.licenseId.slice(0, 8))}</td><td>${escapeHtml(planById.get(l.planId)?.name || l.planId)}</td><td>${statusPill(l.status)}</td><td>${formatNumber(l.maxDevices)}</td><td>${escapeHtml(formatDate(l.expiresAt))}</td><td class="row-actions">${iconButton('manage-license', 'pencil', 'Manage license', `data-id="${escapeHtml(l.licenseId)}"`)}</td></tr>`).join('') : `<tr><td colspan="6" class="blank">No licenses yet.</td></tr>`}
      </tbody></table></div></section>`;
  } else if (bd.tab === 'devices') {
    body = `<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">DEVICES</p><h2>All devices</h2></div></div>
      <div class="table-wrap"><table><thead><tr><th>Device ID</th><th>Name</th><th>Platform</th><th>Status</th><th>Last Seen</th><th>Actions</th></tr></thead><tbody>
        ${bd.devices.length ? bd.devices.map((d) => `<tr><td class="mono">${escapeHtml(d.deviceId.slice(0, 10))}</td><td>${escapeHtml(d.deviceLabel || '—')}</td><td>${escapeHtml(d.platform || '—')}</td><td>${statusPill(d.status)}</td><td>${escapeHtml(formatRelative(d.lastSeenAt))}</td><td class="row-actions">${d.status === 'active' ? iconButton('deactivate-device', 'power', 'Deactivate device', `data-id="${escapeHtml(d.deviceId)}" data-business="${escapeHtml(business.name)}"`) : ''}</td></tr>`).join('') : `<tr><td colspan="6" class="blank">No devices yet.</td></tr>`}
      </tbody></table></div></section>`;
  } else if (bd.tab === 'payments') {
    body = `<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">PAYMENTS</p><h2>All payments</h2></div><button type="button" class="primary-button compact-button" data-action="open-modal" data-kind="payment" data-business="${escapeHtml(business.businessId)}">${icon('plus')}Record Payment</button></div>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        ${bd.payments.length ? bd.payments.map((p) => `<tr><td>${escapeHtml(formatDateTime(p.createdAt))}</td><td><strong>${escapeHtml(formatMoney(p.amountCents, p.currency))}</strong></td><td>${escapeHtml(titleCase(p.method || '—'))}</td><td>${statusPill(p.status)}</td><td class="row-actions">${paymentActions(p)}</td></tr>`).join('') : `<tr><td colspan="5" class="blank">No payments yet.</td></tr>`}
      </tbody></table></div></section>`;
  } else if (bd.tab === 'activity') {
    body = `<section class="panel table-panel"><div class="panel-heading"><div><p class="eyebrow">ACTIVITY</p><h2>Full history</h2></div></div>
      <div class="table-wrap"><table><thead><tr><th>Event</th><th>License</th><th>Device</th><th>Detail</th><th>At</th></tr></thead><tbody>
        ${bd.events.length ? bd.events.map((e) => `<tr><td>${escapeHtml(titleCase(e.type))}</td><td class="mono">${e.licenseId ? escapeHtml(e.licenseId.slice(0, 8)) : '—'}</td><td class="mono">${e.deviceId ? escapeHtml(e.deviceId.slice(0, 10)) : '—'}</td><td>${e.meta?.reason ? escapeHtml(titleCase(e.meta.reason)) : '—'}</td><td>${escapeHtml(formatDateTime(e.at))}</td></tr>`).join('') : `<tr><td colspan="5" class="blank">No activity yet.</td></tr>`}
      </tbody></table></div></section>`;
  }

  return `<div class="detail-header">
    <button type="button" class="text-button back-link" data-action="nav" data-view="businesses">${icon('arrowLeft')}Businesses</button>
    <div class="detail-title-row">
      <h1>${escapeHtml(business.name)} ${statusPill(business.status)}</h1>
      <button type="button" class="secondary-button" data-action="toggle-business-status" data-id="${escapeHtml(business.businessId)}" data-status="${escapeHtml(business.status)}" data-name="${escapeHtml(business.name)}">${icon('pencil')}${business.status === 'active' ? 'Suspend' : 'Activate'}</button>
    </div>
    <p class="subtitle">Business ID: ${escapeHtml(business.businessId)}</p>
  </div>
  ${tabBar}
  <div class="detail-body">${body}</div>`;
}

// ---------- Settings ----------

function settingsView() {
  const prefs = state.prefs;
  return `<section class="settings-grid">
    <article class="panel settings-card"><p class="eyebrow">GENERAL SETTINGS</p><h2>Workspace preferences</h2>
      <form data-form="prefs">
        <label>Workspace name<input name="shopName" placeholder="Your workspace" value="${escapeHtml(prefs.shopName || '')}" /></label>
        <label>Currency<select name="currency"><option value="">Select currency</option>${['USD', 'ZWG', 'ZAR', 'GBP', 'EUR'].map((c) => `<option value="${c}" ${prefs.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label>Receipt footer<input name="receiptFooter" placeholder="Optional receipt footer" value="${escapeHtml(prefs.receiptFooter || '')}" /></label>
        <button type="submit" class="primary-button">Save changes</button>
        <small class="muted">Saved locally in this browser.</small>
      </form>
    </article>
    <article class="panel settings-card"><p class="eyebrow">LICENSE &amp; BACKUP</p><h2>Operational safeguards</h2>
      <div class="setting-row"><span><strong>Your role</strong><small>${escapeHtml(state.role ? (ROLE_LABELS[state.role] || titleCase(state.role)) : 'Loading...')}</small></span><span class="status good"><i></i>Active</span></div>
      <div class="setting-row"><span><strong>Data backup</strong><small>Export a JSON snapshot of your workspace</small></span></div>
      <button type="button" class="secondary-button" data-action="open-backup">${icon('download')}Export / Restore Backup</button>
    </article>
    <article class="panel settings-card"><p class="eyebrow">ACCOUNT &amp; SESSION</p><h2>Identifiers</h2>
      <div class="id-field"><span>Admin UID</span><strong class="mono">${escapeHtml(state.user?.uid || '—')}</strong><button type="button" class="icon-button" data-action="copy-text" data-value="${escapeHtml(state.user?.uid || '')}" title="Copy UID">${icon('copy')}</button></div>
      <div class="id-field"><span>Signed-in email</span><strong class="mono">${escapeHtml(state.user?.email || '—')}</strong><button type="button" class="icon-button" data-action="copy-text" data-value="${escapeHtml(state.user?.email || '')}" title="Copy email">${icon('copy')}</button></div>
    </article>
    <article class="panel settings-card"><p class="eyebrow">SECURITY</p><h2>Administrator settings</h2>
      <div class="setting-row"><span><strong>Signed in account</strong><small>${escapeHtml(state.user?.email || '—')}</small></span><span class="status good"><i></i>Active</span></div>
      <button type="button" class="secondary-button" data-action="reset-password">Send password reset email</button>
    </article>
  </section>`;
}

function backupModalHtml() {
  if (!state.backupModal) return '';
  return `<div class="modal-backdrop" data-action="close-backup"><section class="modal" role="dialog"><button type="button" class="modal-close" data-action="close-backup" aria-label="Close">${icon('close')}</button>
    <p class="eyebrow">SETTINGS</p><h2>Export / Restore Backup</h2>
    <p class="modal-copy">Download a backup of your data. This includes businesses, licenses, devices, plans, and payments.</p>
    <button type="button" class="primary-button" data-action="export-backup">${icon('download')}Download Backup</button>
    <div class="restore-block">
      <p class="modal-copy">Upload a backup file to restore your data. This will replace current data.</p>
      <label class="dropzone" data-action="pick-file"><input type="file" id="restore-file-input" accept="application/json" hidden />
        ${icon('upload')}<span>${state.restoreFile ? escapeHtml(state.restoreFile.name) : 'Drag and drop file here or click to browse'}</span><small>Supports .zip or .json (100MB)</small>
      </label>
      <button type="button" class="secondary-button restore-button" data-action="restore-backup" ${state.restoreFile ? '' : 'disabled'} title="Restore requires backend support — coming soon">Restore</button>
    </div>
  </section></div>`;
}

// ---------- Modals: create / edit ----------

function optionList(items, valueKey, labelKey, placeholder, selected) {
  const options = (items || []).map((item) => `<option value="${escapeHtml(item[valueKey])}" ${selected === item[valueKey] ? 'selected' : ''}>${escapeHtml(item[labelKey] || item[valueKey])}</option>`).join('');
  return `<option value="" ${selected ? '' : 'disabled selected'}>${escapeHtml(placeholder)}</option>${options}`;
}

function businessFields() {
  return `<label>Business name<input name="name" placeholder="Business name" required /></label>
    <label>Contact email<input name="contactEmail" type="email" placeholder="Contact email" /></label>
    <label>Country<input name="country" placeholder="Country" /></label>`;
}

function licenseFields(presetBusinessId) {
  if (!state.modalLookups) return '<p class="modal-copy">Loading businesses and plans...</p>';
  const { businesses, plans, features } = state.modalLookups;
  return `<label>Business<select name="businessId" required ${presetBusinessId ? 'disabled' : ''}>${optionList(businesses, 'businessId', 'name', 'Select business', presetBusinessId)}</select></label>
    ${presetBusinessId ? `<input type="hidden" name="businessId" value="${escapeHtml(presetBusinessId)}" />` : ''}
    <label>Plan<select name="planId" required>${optionList(plans, 'planId', 'name', 'Select plan')}</select></label>
    <label>Maximum devices<input name="maxDevices" type="number" min="1" placeholder="Maximum devices" required /></label>
    <label>Start date<input name="startDate" type="date" /></label>
    <label>Expiry date<input name="expiresAt" type="date" /></label>
    <div class="field-group"><span class="field-title">Enabled features</span><div class="picklist">${featuresPicklist(features)}</div></div>`;
}

function featuresPicklist(features, selected) {
  if (!features) return '<p class="modal-copy">Loading features...</p>';
  if (!features.length) return '<p class="modal-copy">No features defined yet. Add one on the Features page first.</p>';
  const selectedKeys = new Set(selected || []);
  return features.map((f) => `<label class="check-label"><input type="checkbox" name="features" value="${escapeHtml(f.key)}" ${selectedKeys.has(f.key) ? 'checked' : ''} /> ${escapeHtml(f.label)} <span class="muted mono">(${escapeHtml(f.key)})</span></label>`).join('');
}

function planFields(entity, features) {
  return `<label>Plan ID (unique)<input name="planId" placeholder="e.g. pro_monthly" value="${escapeHtml(entity?.planId || '')}" ${entity ? 'readonly' : ''} required /></label>
    <label>Plan name<input name="name" placeholder="Plan name" value="${escapeHtml(entity?.name || '')}" required /></label>
    <label>Price (USD)<input name="price" type="number" min="0" step="0.01" placeholder="0.00" value="${entity ? (entity.priceCents || 0) / 100 : ''}" /></label>
    <label>Maximum devices<input name="maxDevices" type="number" min="1" placeholder="Maximum devices" value="${entity?.maxDevices || ''}" required /></label>
    <label>Billing period<select name="billingPeriod"><option value="monthly" ${entity?.billingPeriod === 'monthly' || !entity ? 'selected' : ''}>Monthly</option><option value="yearly" ${entity?.billingPeriod === 'yearly' ? 'selected' : ''}>Yearly</option></select></label>
    <div class="field-group"><span class="field-title">Enabled features</span><div class="picklist">${featuresPicklist(features, entity?.features)}</div></div>
    ${entity ? `<label>Status<select name="status"><option value="active" ${entity.status === 'active' || !entity.status ? 'selected' : ''}>Active</option><option value="archived" ${entity.status === 'archived' ? 'selected' : ''}>Archived</option></select></label>` : ''}`;
}

function featureFields(entity) {
  return `<label>Key (lowercase_snake_case)<input name="key" placeholder="e.g. inventory_reports" value="${escapeHtml(entity?.key || '')}" ${entity ? 'readonly' : ''} required /></label>
    <label>Label<input name="label" placeholder="Human-readable label" value="${escapeHtml(entity?.label || '')}" required /></label>
    <label>Description<input name="description" placeholder="Optional description" value="${escapeHtml(entity?.description || '')}" /></label>
    <label>Product ID<input name="productId" placeholder="Optional product id" value="${escapeHtml(entity?.productId || '')}" /></label>`;
}

function paymentFields(presetBusinessId) {
  if (!state.modalLookups) return '<p class="modal-copy">Loading businesses...</p>';
  const { businesses } = state.modalLookups;
  return `<label>Business<select name="businessId" required ${presetBusinessId ? 'disabled' : ''}>${optionList(businesses, 'businessId', 'name', 'Select business', presetBusinessId)}</select></label>
    ${presetBusinessId ? `<input type="hidden" name="businessId" value="${escapeHtml(presetBusinessId)}" />` : ''}
    <label>Amount (USD)<input name="amount" type="number" min="0" step="0.01" placeholder="0.00" required /></label>
    <label>Method<select name="method" required><option value="" disabled selected>Select method</option><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="ecocash">EcoCash</option><option value="mobile_money">Mobile money</option><option value="card">Card</option><option value="other">Other</option></select></label>
    <label>Reference<input name="reference" placeholder="Optional reference" /></label>
    <label>Notes<input name="notes" placeholder="Optional notes" /></label>`;
}

function manageLicenseFields(license, plans) {
  return `<div class="id-field"><span>License ID</span><strong class="mono">${escapeHtml(license.licenseId)}</strong><button type="button" class="icon-button" data-action="copy-text" data-value="${escapeHtml(license.licenseId)}" title="Copy license ID">${icon('copy')}</button></div>
    <div class="kv-row"><span>License key</span><button type="button" class="secondary-button filter-button" data-action="regenerate-key" data-id="${escapeHtml(license.licenseId)}">Regenerate key</button></div>
    <div class="kv-row"><span>Current status</span>${statusPill(license.status)}</div>
    <label>Status<select name="status">${['active', 'suspended', 'revoked', 'expired'].map((s) => `<option value="${s}" ${license.status === s ? 'selected' : ''}>${titleCase(s)}</option>`).join('')}</select></label>
    <label>Plan<select name="planId">${optionList(plans, 'planId', 'name', 'Select plan', license.planId)}</select></label>
    <label>Maximum devices<input name="maxDevices" type="number" min="1" value="${license.maxDevices}" /></label>
    <label>Extend expiry by (days)<input name="extendDays" type="number" min="1" placeholder="e.g. 30" /></label>`;
}

function modalTitle(kind) {
  return { business: 'Add Business', license: 'Issue License', plan: 'Add Plan', 'plan-edit': 'Edit Plan', feature: 'Add Feature', 'feature-edit': 'Edit Feature', payment: 'Record Payment', 'manage-license': 'Manage License' }[kind] || 'Add record';
}

function modalFieldsHtml() {
  const kind = state.modal;
  const business = state.modalEntity?.businessId;
  if (kind === 'business') return businessFields();
  if (kind === 'license') return licenseFields(business);
  if (kind === 'plan') return planFields(null, state.modalLookups?.features);
  if (kind === 'plan-edit') return planFields(state.modalEntity, state.modalLookups?.features);
  if (kind === 'feature') return featureFields();
  if (kind === 'feature-edit') return featureFields(state.modalEntity);
  if (kind === 'payment') return paymentFields(business);
  if (kind === 'manage-license') return state.modalLookups ? manageLicenseFields(state.modalEntity, state.modalLookups.plans) : '<p class="modal-copy">Loading...</p>';
  return '';
}

function modalContent() {
  if (state.revealedLicenseKey) {
    return `<div class="modal-backdrop" data-action="close-key-reveal"><section class="modal" role="dialog"><button type="button" class="modal-close" data-action="close-key-reveal" aria-label="Close">${icon('close')}</button><p class="eyebrow">LICENSE ISSUED</p><h2>Save this license key now</h2><p class="modal-copy">This is shown once and stored only as a hash — it cannot be recovered later. Give it to the business owner.</p><div class="id-field"><strong class="mono">${escapeHtml(state.revealedLicenseKey)}</strong><button type="button" class="icon-button" data-action="copy-text" data-value="${escapeHtml(state.revealedLicenseKey)}" title="Copy license key">${icon('copy')}</button></div><div class="modal-actions"><button type="button" class="primary-button" data-action="close-key-reveal">Done</button></div></section></div>`;
  }
  if (!state.modal) return '';
  const title = modalTitle(state.modal);
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog"><button type="button" class="modal-close" data-action="close-modal" aria-label="Close">${icon('close')}</button><p class="eyebrow">ADMINISTRATION</p><h2>${escapeHtml(title)}</h2><form data-form="entity" class="entity-form">${modalFieldsHtml()}${state.modalError ? `<p class="form-error">${escapeHtml(state.modalError)}</p>` : ''}<div class="modal-actions"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button type="submit" class="primary-button" ${state.modalSaving ? 'disabled' : ''}>${state.modalSaving ? 'Saving...' : title}</button></div></form></section></div>`;
}

function confirmDialogHtml() {
  const c = state.confirm;
  if (!c) return '';
  return `<div class="modal-backdrop" data-action="close-confirm"><section class="modal confirm-modal" role="alertdialog"><button type="button" class="modal-close" data-action="close-confirm" aria-label="Close">${icon('close')}</button>
    <span class="confirm-icon ${c.danger ? 'danger' : ''}">${icon(c.danger ? 'alert' : 'power')}</span>
    <h2>${escapeHtml(c.title)}</h2><p class="modal-copy">${escapeHtml(c.message)}</p>
    <div class="modal-actions"><button type="button" class="secondary-button" data-action="close-confirm">Cancel</button><button type="button" class="primary-button ${c.danger ? 'danger-button' : ''}" data-action="confirm-yes">${escapeHtml(c.confirmLabel)}</button></div>
  </section></div>`;
}

function toastHtml() {
  if (!state.toast) return '';
  return `<div class="toast toast-${state.toast.tone}">${icon(state.toast.tone === 'good' ? 'check' : 'alert')}<span>${escapeHtml(state.toast.message)}</span><button type="button" class="toast-close" data-action="dismiss-toast" aria-label="Dismiss">${icon('close')}</button></div>`;
}

// ---------- main render ----------

function contentForView() {
  if (state.view === 'overview') return overviewContent();
  if (state.view === 'businesses') return businessesView();
  if (state.view === 'licenses') return licensesView();
  if (state.view === 'devices') return devicesView();
  if (state.view === 'plans') return plansView();
  if (state.view === 'payments') return paymentsView();
  if (state.view === 'features') return featuresView();
  if (state.view === 'audit') return auditView(false);
  if (state.view === 'attempts') return auditView(true);
  if (state.view === 'settings') return settingsView();
  if (state.view === 'business-detail') return businessDetailView();
  return '';
}

function renderApp() {
  if (!state.user) { renderLogin(); return; }
  const isDetail = state.view === 'business-detail';
  app.innerHTML = `<div class="app-shell">
    ${sidebarHtml()}
    <main class="main-content">
      ${topbarHtml()}
      ${isDetail ? '' : pageHeadingHtml()}
      <div class="content">${contentForView()}</div>
    </main>
  </div>
  ${modalContent()}
  ${confirmDialogHtml()}
  ${backupModalHtml()}
  ${toastHtml()}`;
}

// ---------- actions ----------

async function withSaving(fn) {
  try {
    await fn();
  } catch (error) {
    showToast(error.message, 'bad');
  }
}

function openModal(kind, entity) {
  state.modal = kind;
  state.modalError = null;
  state.modalLookups = null;
  state.modalEntity = entity || null;
  renderApp();
  if (kind === 'license' || kind === 'payment') {
    apiCall('adminListBusinesses', { limit: 100 })
      .then(async (businessesResult) => {
        if (kind === 'license') {
          const [plansResult, featuresResult] = await Promise.all([apiCall('adminListPlans'), apiCall('adminListFeatures')]);
          state.modalLookups = { businesses: businessesResult.businesses, plans: plansResult.plans, features: featuresResult.features };
        } else {
          state.modalLookups = { businesses: businessesResult.businesses };
        }
        renderApp();
      })
      .catch((error) => { state.modalError = error.message; renderApp(); });
  } else if (kind === 'manage-license') {
    apiCall('adminListPlans')
      .then((result) => { state.modalLookups = { plans: result.plans }; renderApp(); })
      .catch((error) => { state.modalError = error.message; renderApp(); });
  } else if (kind === 'plan' || kind === 'plan-edit') {
    apiCall('adminListFeatures')
      .then((result) => { state.modalLookups = { features: result.features }; renderApp(); })
      .catch((error) => { state.modalError = error.message; renderApp(); });
  }
}

function closeModal() {
  state.modal = null;
  state.modalError = null;
  state.modalLookups = null;
  state.modalEntity = null;
  renderApp();
}

async function refreshCurrentView() {
  if (state.view === 'business-detail' && state.businessDetail) await loadBusinessDetail(state.businessDetail.id, state.businessDetail.tab);
  else await loadViewData(true);
}

async function submitEntityForm(form) {
  const data = new FormData(form);
  state.modalSaving = true;
  state.modalError = null;
  renderApp();
  try {
    if (state.modal === 'business') {
      await apiCall('adminCreateBusiness', { name: data.get('name'), contactEmail: data.get('contactEmail') || null, country: data.get('country') || null });
      showToast('Business created successfully');
      closeModal();
    } else if (state.modal === 'plan') {
      await apiCall('adminCreatePlan', {
        planId: data.get('planId'), name: data.get('name'), priceCents: Math.round(Number(data.get('price') || 0) * 100),
        maxDevices: Number(data.get('maxDevices')), billingPeriod: data.get('billingPeriod'), features: data.getAll('features'),
      });
      showToast('Plan created successfully');
      closeModal();
    } else if (state.modal === 'plan-edit') {
      await apiCall('adminUpdatePlan', {
        planId: state.modalEntity.planId, name: data.get('name'), priceCents: Math.round(Number(data.get('price') || 0) * 100),
        maxDevices: Number(data.get('maxDevices')), billingPeriod: data.get('billingPeriod'), features: data.getAll('features'), status: data.get('status'),
      });
      showToast('Plan updated successfully');
      closeModal();
    } else if (state.modal === 'feature') {
      await apiCall('adminCreateFeature', { key: data.get('key'), label: data.get('label'), description: data.get('description') || null, productId: data.get('productId') || null });
      showToast('Feature created successfully');
      closeModal();
    } else if (state.modal === 'feature-edit') {
      await apiCall('adminUpdateFeature', { key: state.modalEntity.key, label: data.get('label'), description: data.get('description') || null, productId: data.get('productId') || null });
      showToast('Feature updated successfully');
      closeModal();
    } else if (state.modal === 'payment') {
      await apiCall('adminRecordPayment', { businessId: data.get('businessId'), amountCents: Math.round(Number(data.get('amount') || 0) * 100), currency: 'USD', method: data.get('method'), reference: data.get('reference') || null, notes: data.get('notes') || null });
      showToast('Payment recorded successfully');
      closeModal();
    } else if (state.modal === 'license') {
      const result = await apiCall('adminCreateLicense', {
        businessId: data.get('businessId'), planId: data.get('planId'), maxDevices: Number(data.get('maxDevices')),
        startDate: data.get('startDate') || null, expiresAt: data.get('expiresAt') || null, features: data.getAll('features'),
      });
      state.modal = null;
      state.modalLookups = null;
      state.modalEntity = null;
      state.revealedLicenseKey = result.licenseKey;
    } else if (state.modal === 'manage-license') {
      const license = state.modalEntity;
      const updates = {};
      const extendDays = Number(data.get('extendDays') || 0);
      if (extendDays > 0) updates.extendDays = extendDays;
      if (data.get('planId') && data.get('planId') !== license.planId) updates.planId = data.get('planId');
      const maxDevices = Number(data.get('maxDevices'));
      if (maxDevices && maxDevices !== license.maxDevices) updates.maxDevices = maxDevices;
      if (Object.keys(updates).length) await apiCall('adminUpdateLicense', { licenseId: license.licenseId, ...updates });
      if (data.get('status') !== license.status) await apiCall('adminSetLicenseStatus', { licenseId: license.licenseId, status: data.get('status') });
      showToast('License updated successfully');
      closeModal();
    }
    state.modalSaving = false;
    await refreshCurrentView();
  } catch (error) {
    state.modalSaving = false;
    state.modalError = error.message;
    renderApp();
  }
}

function openConfirm({ title, message, confirmLabel, danger, run }) {
  state.confirm = { title, message, confirmLabel, danger, run };
  renderApp();
}

async function handleConfirmYes() {
  const c = state.confirm;
  if (!c) return;
  state.confirm = null;
  await withSaving(async () => {
    const message = await c.run();
    if (message !== null) showToast(message || 'Done');
    await refreshCurrentView();
  });
  renderApp();
}

const DEFAULT_FEATURES = [
  { key: 'pos', label: 'Point of sale', description: 'Core checkout and transaction workflows', productId: 'tylliq-core' },
  { key: 'inventory', label: 'Inventory', description: 'Stock levels, transfers, and adjustments', productId: 'tylliq-core' },
  { key: 'reports', label: 'Reports', description: 'Sales and operational reporting', productId: 'tylliq-core' },
  { key: 'multi_location', label: 'Multi-location', description: 'Manage multiple branches from one account', productId: 'tylliq-enterprise' },
  { key: 'priority_support', label: 'Priority support', description: 'Accelerated support response times', productId: 'tylliq-enterprise' },
];

function seedDefaultFeatures() {
  withSaving(async () => {
    const existing = new Set((state.data?.features || []).map((f) => f.key));
    let added = 0;
    for (const f of DEFAULT_FEATURES) {
      if (existing.has(f.key)) continue;
      await apiCall('adminCreateFeature', f);
      added++;
    }
    showToast(added ? `Added ${added} default feature${added === 1 ? '' : 's'}` : 'Default features are already set up');
    await refreshCurrentView();
  });
}

function exportBackup() {
  withSaving(async () => {
    const [businesses, licenses, devices, plans, payments, features] = await Promise.all([
      apiCall('adminListBusinesses', { limit: 100 }), apiCall('adminListLicenses', { limit: 100 }),
      apiCall('adminListDevices', { limit: 200 }), apiCall('adminListPlans'),
      apiCall('adminListPayments', { limit: 100 }), apiCall('adminListFeatures'),
    ]);
    const backup = {
      exportedAt: new Date().toISOString(), exportedBy: state.user?.email,
      businesses: businesses.businesses, licenses: licenses.licenses, devices: devices.devices,
      plans: plans.plans, payments: payments.payments, features: features.features,
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tylliq-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('Backup exported successfully');
  });
}

// ---------- delegated events ----------

function handleAction(action, target, event) {
  const view = target.dataset.view;
  const id = target.dataset.id;
  switch (action) {
    case 'nav': {
      resetListState();
      state.view = view;
      state.businessDetail = null;
      if (target.dataset.status) state.filters.status = target.dataset.status;
      state.sidebarOpen = false;
      loadViewData();
      return;
    }
    case 'toggle-sidebar': state.sidebarOpen = !state.sidebarOpen; renderApp(); return;
    case 'close-sidebar': state.sidebarOpen = false; renderApp(); return;
    case 'toggle-notifications':
      state.notifOpen = !state.notifOpen;
      state.accountOpen = false;
      if (state.notifOpen) loadNotifications(); else renderApp();
      return;
    case 'toggle-account': state.accountOpen = !state.accountOpen; state.notifOpen = false; renderApp(); return;
    case 'close-panels': state.notifOpen = false; state.accountOpen = false; renderApp(); return;
    case 'refresh': refreshCurrentView(); return;
    case 'toggle-password': {
      const passwordInput = document.querySelector('input[name="password"]');
      const showing = passwordInput.type === 'text';
      passwordInput.type = showing ? 'password' : 'text';
      target.innerHTML = icon(showing ? 'eyeClosed' : 'eyeOpen');
      target.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      return;
    }
    case 'forgot-password': {
      const email = document.querySelector('input[name="email"]')?.value.trim();
      if (!email) { renderLogin('', 'Enter your email address above first, then click "Forgot password?" again.'); return; }
      sendPasswordResetEmail(auth, email)
        .then(() => renderLogin('', `Password reset email sent to ${email}. Check your inbox.`))
        .catch((error) => renderLogin(error.code === 'auth/user-not-found' ? 'No account found for that email.' : error.message));
      return;
    }
    case 'signout': signOut(auth); return;
    case 'open-business': if (id) loadBusinessDetail(id); return;
    case 'detail-tab': if (state.businessDetail) { state.businessDetail.tab = target.dataset.tab; renderApp(); } return;
    case 'open-modal': openModal(target.dataset.kind, target.dataset.kind === 'plan-edit' ? (state.data.plans || []).find((p) => p.planId === id) : target.dataset.kind === 'feature-edit' ? (state.data.features || []).find((f) => f.key === id) : (target.dataset.business ? { businessId: target.dataset.business } : null)); return;
    case 'close-modal': if (event.target === target) closeModal(); return;
    case 'close-key-reveal': if (event.target === target) { state.revealedLicenseKey = null; renderApp(); } return;
    case 'copy-text': navigator.clipboard?.writeText(target.dataset.value || ''); showToast('Copied to clipboard'); return;
    case 'manage-license': {
      const source = state.view === 'business-detail' ? state.businessDetail.licenses : (state.data?.licenses || []);
      const license = source.find((l) => l.licenseId === id);
      if (license) openModal('manage-license', license);
      return;
    }
    case 'regenerate-key': {
      openConfirm({
        title: 'Regenerate license key?',
        message: 'The current license key stops working for new activations immediately. Devices already activated on this license are unaffected. The new key is shown once and cannot be recovered later.',
        confirmLabel: 'Regenerate',
        danger: true,
        run: async () => {
          const result = await apiCall('adminRegenerateLicenseKey', { licenseId: id });
          state.modal = null;
          state.modalLookups = null;
          state.modalEntity = null;
          state.revealedLicenseKey = result.licenseKey;
          return null;
        },
      });
      return;
    }
    case 'toggle-business-status': {
      const nextStatus = target.dataset.status === 'active' ? 'suspended' : 'active';
      openConfirm({
        title: `${nextStatus === 'active' ? 'Activate' : 'Suspend'} ${target.dataset.name}?`,
        message: nextStatus === 'active' ? 'This business will regain access immediately.' : 'This business and its devices will lose access until reactivated.',
        confirmLabel: nextStatus === 'active' ? 'Activate' : 'Suspend',
        danger: nextStatus !== 'active',
        run: async () => { await apiCall('adminSetBusinessStatus', { businessId: id, status: nextStatus }); return `Business ${nextStatus === 'active' ? 'activated' : 'suspended'}`; },
      });
      return;
    }
    case 'deactivate-device': {
      openConfirm({
        title: 'Deactivate this device?',
        message: `This frees up a device slot for ${target.dataset.business || 'this business'}. The device will need to reactivate to be used again.`,
        confirmLabel: 'Deactivate',
        danger: true,
        run: async () => { await apiCall('adminDeactivateDevice', { deviceId: id }); return 'Device deactivated'; },
      });
      return;
    }
    case 'set-payment-status': {
      const status = target.dataset.status;
      openConfirm({
        title: status === 'confirmed' ? 'Confirm this payment?' : status === 'rejected' ? 'Reject this payment?' : 'Refund this payment?',
        message: 'This will update the payment record and be recorded in the audit log.',
        confirmLabel: titleCase(status),
        danger: status !== 'confirmed',
        run: async () => { await apiCall('adminSetPaymentStatus', { paymentId: id, status }); return `Payment ${status}`; },
      });
      return;
    }
    case 'close-confirm': if (event.target === target) { state.confirm = null; renderApp(); } return;
    case 'confirm-yes': handleConfirmYes(); return;
    case 'dismiss-toast': state.toastId += 1; state.toast = null; renderApp(); return;
    case 'search': return;
    case 'filter-reset': resetListState(); renderApp(); return;
    case 'open-backup': state.backupModal = true; state.restoreFile = null; renderApp(); return;
    case 'close-backup': if (event.target === target) { state.backupModal = false; renderApp(); } return;
    case 'export-backup': exportBackup(); return;
    case 'seed-default-features': seedDefaultFeatures(); return;
    case 'pick-file': document.getElementById('restore-file-input')?.click(); return;
    case 'restore-backup': showToast('Restoring from a backup file isn’t available yet. Contact support for assistance.', 'bad'); return;
    case 'reset-password': {
      if (!state.user?.email) return;
      sendPasswordResetEmail(auth, state.user.email).then(() => showToast('Password reset email sent')).catch((error) => showToast(error.message, 'bad'));
      return;
    }
    case 'page': { const p = Number(target.dataset.page); if (p) { state.page = p; renderApp(); } return; }
    default: return;
  }
}

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  handleAction(target.dataset.action, target, event);
});

app.addEventListener('submit', (event) => {
  const formKind = event.target.dataset.form;
  if (!formKind) return;
  event.preventDefault();
  if (formKind === 'login') {
    const data = new FormData(event.target);
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Signing in...';
    signInWithEmailAndPassword(auth, data.get('email'), data.get('password')).catch((error) => {
      renderLogin(error.code === 'auth/invalid-credential' ? 'Email or password not recognized.' : error.message);
    });
  } else if (formKind === 'entity') {
    submitEntityForm(event.target);
  } else if (formKind === 'prefs') {
    const data = new FormData(event.target);
    state.prefs = { shopName: data.get('shopName') || '', currency: data.get('currency') || '', receiptFooter: data.get('receiptFooter') || '' };
    localStorage.setItem('tylliq_prefs', JSON.stringify(state.prefs));
    showToast('Preferences saved');
  } else if (formKind === 'global-search') {
    const data = new FormData(event.target);
    const term = (data.get('q') || '').trim();
    if (['businesses', 'licenses', 'devices'].includes(state.view)) {
      state.filters.search = term;
      state.page = 1;
    } else {
      state.view = 'businesses';
      state.filters = { search: term, status: 'all', plan: 'all', business: 'all' };
      state.page = 1;
      loadViewData();
      return;
    }
    renderApp();
  }
});

app.addEventListener('input', (event) => {
  if (event.target.dataset.action === 'search') {
    state.filters.search = event.target.value;
    state.page = 1;
    renderApp();
    document.querySelector('[data-action="search"]')?.focus();
    const el = document.querySelector('[data-action="search"]');
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }
});

app.addEventListener('change', (event) => {
  const action = event.target.dataset.action;
  if (action === 'filter-status') { state.filters.status = event.target.value; state.page = 1; renderApp(); }
  else if (action === 'filter-plan') { state.filters.plan = event.target.value; state.page = 1; renderApp(); }
  else if (action === 'filter-business') { state.filters.business = event.target.value; state.page = 1; renderApp(); }
  else if (action === 'page-size') { state.pageSize = Number(event.target.value); state.page = 1; renderApp(); }
  else if (event.target.id === 'restore-file-input') {
    state.restoreFile = event.target.files?.[0] || null;
    renderApp();
  }
});

// ---------- bootstrap ----------

renderLoading();
onAuthStateChanged(auth, async (user) => {
  state.booting = false;
  state.user = user;
  state.role = null;
  if (user) {
    try {
      const tokenResult = await user.getIdTokenResult();
      state.role = tokenResult.claims.role || null;
    } catch { /* role stays null if lookup fails */ }
    loadViewData();
  } else {
    renderLogin();
  }
});
