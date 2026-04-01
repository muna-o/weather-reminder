/* ── State ──────────────────────────────────────────────────────────────── */
const state = {
  locations: [],
  alerts: [],
  notifications: [],
  currentPage: 'dashboard',
  dashLocationId: null,
  unreadCount: 0,
  pollInterval: null,
};

const CONDITION_LABELS = {
  rain: 'Rain',
  snow: 'Snow',
  high_temp: 'High temp',
  low_temp: 'Low temp',
  high_wind: 'High wind',
  thunderstorm: 'Thunderstorm',
  fog: 'Fog',
  uv: 'High UV',
  humidity: 'Humidity',
};

const THRESHOLD_CONFIG = {
  rain: [{ key: 'rain_mm', label: 'Min precipitation (mm)', default: 0.5, step: 0.1 }],
  high_temp: [{ key: 'high_temp_f', label: 'Temperature threshold (°F)', default: 90, step: 1 }],
  low_temp: [{ key: 'low_temp_f', label: 'Temperature threshold (°F)', default: 32, step: 1 }],
  high_wind: [{ key: 'wind_mph', label: 'Wind speed threshold (mph)', default: 25, step: 1 }],
  uv: [{ key: 'uv_index', label: 'UV index threshold', default: 7, step: 1 }],
  humidity: [{ key: 'humidity_pct', label: 'Humidity threshold (%)', default: 85, step: 1 }],
};

/* ── API ────────────────────────────────────────────────────────────────── */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: 'Request failed' }));
    throw new Error(err.detail || 'Request failed');
  }
  return r.json();
}

const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b);
const patch = (p, b) => api('PATCH', p, b);
const del = (p) => api('DELETE', p);

/* ── Toast ──────────────────────────────────────────────────────────────── */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ── Navigation ─────────────────────────────────────────────────────────── */
function openPage(page) {
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('active');
    p.classList.add('hidden');
  });
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const el = document.getElementById(`page-${page}`);
  if (el) { el.classList.remove('hidden'); el.classList.add('active'); }
  const nav = document.querySelector(`[data-page="${page}"]`);
  if (nav) nav.classList.add('active');

  state.currentPage = page;

  if (page === 'dashboard') loadDashboard();
  if (page === 'alerts') loadAlerts();
  if (page === 'locations') loadLocations();
  if (page === 'notifications') loadNotifications();
}

/* ── Locations ──────────────────────────────────────────────────────────── */
async function loadLocations() {
  const locs = await get('/api/locations').catch(() => []);
  state.locations = locs;
  renderLocationsList();
  populateLocationSelects();
}

function renderLocationsList() {
  const list = document.getElementById('locations-list');
  if (!list) return;
  if (!state.locations.length) {
    list.innerHTML = '<p style="color:var(--ink-3);font-size:13px;padding:1rem 0;">No locations added yet.</p>';
    return;
  }
  list.innerHTML = state.locations.map(loc => `
    <div class="location-item ${loc.is_current ? 'is-current' : ''}">
      <div class="location-dot"></div>
      <div class="location-info">
        <div class="location-item-name">${esc(loc.name)}</div>
        <div class="location-item-query">${esc(loc.query)}${loc.is_current ? ' · <strong style="color:var(--accent)">Active</strong>' : ''}</div>
      </div>
      <div class="location-controls">
        ${!loc.is_current ? `<button class="btn-set-current" onclick="setCurrentLocation(${loc.id})">Set active</button>` : ''}
        <button class="btn-delete" onclick="deleteLocation(${loc.id})" title="Remove">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>
    </div>
  `).join('');
}

function populateLocationSelects() {
  const selects = ['dash-location-select', 'modal-location'];
  selects.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = '<option value="">Choose a location…</option>' +
      state.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    if (prev) el.value = prev;
  });

  // Auto-select current location in dashboard
  const current = state.locations.find(l => l.is_current);
  const dashSel = document.getElementById('dash-location-select');
  if (current && dashSel && !dashSel.value) {
    dashSel.value = current.id;
    state.dashLocationId = current.id;
  }
}

async function addLocation() {
  const name = document.getElementById('loc-name').value.trim();
  const query = document.getElementById('loc-query').value.trim();
  if (!name || !query) { toast('Please fill in both fields', 'warn'); return; }

  try {
    const isFirst = state.locations.length === 0;
    await post('/api/locations', { name, query, is_current: isFirst });
    document.getElementById('loc-name').value = '';
    document.getElementById('loc-query').value = '';
    toast('Location added');
    await loadLocations();
    if (isFirst) loadDashboardWeather();
  } catch (e) {
    toast(e.message, 'warn');
  }
}

async function setCurrentLocation(id) {
  await patch(`/api/locations/${id}/set-current`);
  toast('Active location updated');
  await loadLocations();
  loadDashboardWeather();
}

async function deleteLocation(id) {
  if (!confirm('Remove this location and all its alerts?')) return;
  await del(`/api/locations/${id}`);
  toast('Location removed');
  await loadLocations();
}

async function requestGPSForLocation() {
  if (!navigator.geolocation) { toast('Geolocation not supported', 'warn'); return; }
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lon } = pos.coords;
    const query = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const isFirst = state.locations.length === 0;
    try {
      await post('/api/locations', { name: 'My Location', query, lat, lon, is_current: isFirst });
      toast('GPS location added');
      await loadLocations();
      if (isFirst) loadDashboardWeather();
    } catch (e) {
      toast(e.message, 'warn');
    }
  }, () => toast('Could not get GPS location', 'warn'));
}

async function requestGPS() {
  if (!navigator.geolocation) { toast('Geolocation not supported', 'warn'); return; }
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lon } = pos.coords;
    const query = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    // Check if GPS location already exists
    const exists = state.locations.find(l => l.query === query);
    if (exists) {
      await setCurrentLocation(exists.id);
      const sel = document.getElementById('dash-location-select');
      if (sel) { sel.value = exists.id; state.dashLocationId = exists.id; loadDashboardWeather(); }
    } else {
      const isFirst = state.locations.length === 0;
      await post('/api/locations', { name: 'My Location', query, lat, lon, is_current: true });
      await loadLocations();
      loadDashboardWeather();
    }
  }, () => toast('Could not get GPS location', 'warn'));
}

/* ── Dashboard ──────────────────────────────────────────────────────────── */
async function loadDashboard() {
  await loadLocations();
  loadDashboardWeather();
  loadAlerts();
}

async function loadDashboardWeather() {
  const sel = document.getElementById('dash-location-select');
  const locId = sel ? sel.value : null;
  state.dashLocationId = locId;

  const loading = document.getElementById('dash-loading');
  const content = document.getElementById('dash-content');
  const empty = document.getElementById('dash-empty');

  if (!locId) {
    loading.classList.add('hidden');
    content.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  loading.classList.remove('hidden');
  content.classList.add('hidden');
  empty.classList.add('hidden');

  try {
    const data = await get(`/api/weather/${locId}`);
    renderWeather(data, locId);
    loading.classList.add('hidden');
    content.classList.remove('hidden');
  } catch (e) {
    loading.classList.add('hidden');
    empty.classList.remove('hidden');
    document.getElementById('dash-empty').querySelector('p').textContent = `Error: ${e.message}`;
    toast(e.message, 'warn');
  }
}

function renderWeather(data, locId) {
  const cur = data.current || {};
  const loc = data.location || {};

  document.getElementById('dash-temp').textContent = `${cur.temperature ?? '--'}°F`;
  document.getElementById('dash-desc').textContent = (cur.weather_descriptions || ['--'])[0];
  document.getElementById('dash-loc-name').textContent = `${loc.name || ''}, ${loc.country || ''}`;
  document.getElementById('dash-location-label').textContent = `${loc.name || ''} · Updated ${formatTime(loc.localtime)}`;
  document.getElementById('dash-feels').textContent = `${cur.feelslike ?? '--'}°F`;
  document.getElementById('dash-humidity').textContent = `${cur.humidity ?? '--'}%`;
  document.getElementById('dash-wind').textContent = `${cur.wind_speed ?? '--'} mph ${cur.wind_dir || ''}`;
  document.getElementById('dash-visibility').textContent = `${cur.visibility ?? '--'} mi`;
  document.getElementById('dash-uv').textContent = cur.uv_index ?? '--';
  document.getElementById('dash-precip').textContent = `${cur.precip ?? '--'} mm`;

  const icon = document.getElementById('dash-icon');
  const iconUrl = (cur.weather_icons || [])[0];
  if (iconUrl) { icon.src = iconUrl; icon.style.display = 'block'; }
  else icon.style.display = 'none';

  // Dashboard alerts for this location
  const locAlerts = state.alerts.filter(a => String(a.location_id) === String(locId));
  const dashAlerts = document.getElementById('dash-alerts-list');
  if (!locAlerts.length) {
    dashAlerts.innerHTML = '<p style="font-size:13px;color:var(--ink-3);padding:6px 0;">No alerts for this location. <a href="#" onclick="openPage(\'alerts\')" style="color:var(--ink-2)">Create one →</a></p>';
  } else {
    dashAlerts.innerHTML = locAlerts.map(a => `
      <div class="dash-alert-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">${esc(a.name)}</div>
          <div style="font-size:11px;color:var(--ink-3);margin-top:2px">${a.conditions.map(c => CONDITION_LABELS[c] || c).join(', ')}</div>
        </div>
        <span class="status-pill ${a.status || 'monitoring'}">
          <span class="status-dot-sm"></span>
          ${a.status === 'triggered' ? 'Triggered' : a.is_active ? 'Monitoring' : 'Inactive'}
        </span>
      </div>
    `).join('');
  }
}

/* ── Alerts ─────────────────────────────────────────────────────────────── */
async function loadAlerts() {
  const alerts = await get('/api/alerts').catch(() => []);
  state.alerts = alerts;
  renderAlerts();
}

function renderAlerts() {
  const list = document.getElementById('alerts-list');
  const empty = document.getElementById('alerts-empty');
  if (!list) return;

  if (!state.alerts.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = state.alerts.map(a => {
    const conds = a.conditions.map(c => CONDITION_LABELS[c] || c).join(', ');
    const status = a.is_active ? (a.status || 'monitoring') : 'inactive';
    const statusLabel = status === 'triggered' ? 'Triggered' : status === 'monitoring' ? 'Monitoring' : 'Inactive';
    const advance = a.advance_hours >= 1 ? `${a.advance_hours}h` : `${Math.round(a.advance_hours * 60)}m`;
    return `
      <div class="alert-card ${a.is_active ? '' : 'inactive'}">
        <div class="alert-info">
          <div class="alert-name">${esc(a.name)}</div>
          <div class="alert-meta">${esc(a.location_name)} · ${conds} · ${advance} ahead</div>
        </div>
        <div class="alert-controls">
          <span class="status-pill ${status}"><span class="status-dot-sm"></span>${statusLabel}</span>
          <button class="btn-check" onclick="checkAlertNow(${a.id})">Check now</button>
          <div class="toggle ${a.is_active ? 'on' : ''}" onclick="toggleAlert(${a.id}, ${a.is_active})">
            <div class="toggle-thumb"></div>
          </div>
          <button class="btn-delete" onclick="deleteAlert(${a.id})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function toggleAlert(id, currentlyActive) {
  await patch(`/api/alerts/${id}`, { is_active: !currentlyActive });
  await loadAlerts();
}

async function deleteAlert(id) {
  if (!confirm('Delete this alert?')) return;
  await del(`/api/alerts/${id}`);
  toast('Alert deleted');
  await loadAlerts();
}

async function checkAlertNow(id) {
  try {
    const result = await post(`/api/alerts/${id}/check-now`);
    if (result.triggered && result.triggered.length) {
      toast(`Conditions met: ${result.triggered.join(', ')}`, 'warn');
      await loadNotificationCount();
    } else {
      toast('No conditions met right now');
    }
    await loadAlerts();
  } catch (e) {
    toast(e.message, 'warn');
  }
}

/* ── Alert Modal ────────────────────────────────────────────────────────── */
function openAlertModal() {
  loadLocations().then(() => {
    populateLocationSelects();
  });
  document.getElementById('alert-modal').classList.remove('hidden');
  document.getElementById('modal-name').value = '';
  document.getElementById('modal-advance').value = 1;
  document.getElementById('advance-label').textContent = '1 hour';
  document.querySelectorAll('.cond-tag').forEach(t => t.classList.remove('active'));
  document.getElementById('threshold-fields').innerHTML = '';
}

function closeAlertModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('alert-modal').classList.add('hidden');
}

document.querySelectorAll('.cond-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    tag.classList.toggle('active');
    updateThresholdFields();
  });
});

function updateThresholdFields() {
  const active = [...document.querySelectorAll('.cond-tag.active')].map(t => t.dataset.cond);
  const container = document.getElementById('threshold-fields');
  container.innerHTML = '';

  active.forEach(cond => {
    const fields = THRESHOLD_CONFIG[cond];
    if (!fields) return;
    fields.forEach(f => {
      const row = document.createElement('div');
      row.className = 'threshold-row';
      row.innerHTML = `
        <span class="threshold-label">${f.label}</span>
        <input type="number" id="thresh-${f.key}" value="${f.default}" step="${f.step}" min="0">
      `;
      container.appendChild(row);
    });
  });
}

function updateAdvanceLabel(val) {
  const h = parseFloat(val);
  document.getElementById('advance-label').textContent =
    h < 1 ? `${Math.round(h * 60)} minutes` : h === 1 ? '1 hour' : `${h} hours`;
}

async function saveAlert() {
  const name = document.getElementById('modal-name').value.trim();
  const locationId = document.getElementById('modal-location').value;
  const conditions = [...document.querySelectorAll('.cond-tag.active')].map(t => t.dataset.cond);
  const advance = parseFloat(document.getElementById('modal-advance').value);
  const browserNotify = document.getElementById('modal-browser').checked;

  if (!name) { toast('Please add a name', 'warn'); return; }
  if (!locationId) { toast('Please select a location', 'warn'); return; }
  if (!conditions.length) { toast('Select at least one condition', 'warn'); return; }

  const thresholds = {};
  conditions.forEach(cond => {
    const fields = THRESHOLD_CONFIG[cond] || [];
    fields.forEach(f => {
      const el = document.getElementById(`thresh-${f.key}`);
      if (el) thresholds[f.key] = parseFloat(el.value);
    });
  });

  try {
    await post('/api/alerts', {
      name,
      location_id: parseInt(locationId),
      conditions,
      thresholds,
      advance_hours: advance,
      browser_notify: browserNotify,
    });
    closeAlertModal();
    toast('Alert saved', 'success');
    await loadAlerts();

    if (browserNotify && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch (e) {
    toast(e.message, 'warn');
  }
}

/* ── Notifications ──────────────────────────────────────────────────────── */
async function loadNotifications() {
  const notifs = await get('/api/notifications').catch(() => []);
  state.notifications = notifs;
  renderNotifications();
  updateUnreadBadge(notifs.filter(n => !n.is_read).length);
}

async function loadNotificationCount() {
  const data = await get('/api/notifications/unread-count').catch(() => ({ count: 0 }));
  updateUnreadBadge(data.count);
}

function updateUnreadBadge(count) {
  state.unreadCount = count;
  const badge = document.getElementById('notif-badge');
  const bell = document.getElementById('notif-badge');
  const bellBadge = document.getElementById('notif-badge');
  const navBadge = document.getElementById('nav-badge');
  const bellEl = document.querySelector('#notif-bell #notif-badge');

  [navBadge, document.getElementById('notif-badge')].forEach(el => {
    if (!el) return;
    if (count > 0) { el.textContent = count; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  });
}

function renderNotifications() {
  const list = document.getElementById('notif-list');
  const empty = document.getElementById('notif-empty');
  if (!list) return;

  if (!state.notifications.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = state.notifications.map(n => `
    <div class="notif-item ${n.is_read ? 'read' : 'unread'}" id="notif-${n.id}">
      <div class="notif-dot"></div>
      <div class="notif-body">
        <div class="notif-title">${esc(n.alert_name)}</div>
        <div class="notif-msg">${esc(n.message)}</div>
        ${n.conditions_met && n.conditions_met.length ? `
          <div class="notif-conditions">
            ${n.conditions_met.map(c => `<span class="notif-cond-pill">${esc(c)}</span>`).join('')}
          </div>` : ''}
        <div class="notif-time">${formatDate(n.created_at)}</div>
      </div>
      <div class="notif-actions">
        ${!n.is_read ? `<button class="btn-check" onclick="markOneRead(${n.id})">Mark read</button>` : ''}
        <button class="btn-delete" onclick="deleteNotif(${n.id})">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
  `).join('');
}

async function markAllRead() {
  await post('/api/notifications/mark-read');
  toast('All marked as read');
  await loadNotifications();
}

async function markOneRead(id) {
  await patch(`/api/notifications/${id}/read`);
  await loadNotifications();
}

async function deleteNotif(id) {
  await del(`/api/notifications/${id}`);
  await loadNotifications();
}

/* ── Browser push notifications ─────────────────────────────────────────── */
function sendBrowserNotif(title, body) {
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/static/favicon.ico' });
  }
}

/* ── Polling ────────────────────────────────────────────────────────────── */
async function pollNow() {
  const dot = document.getElementById('poll-dot');
  const label = document.getElementById('poll-label');
  dot.classList.add('active');
  label.textContent = 'Checking…';
  try {
    await post('/api/poll-now');
    toast('Check complete');
    await loadNotificationCount();
    if (state.currentPage === 'alerts') await loadAlerts();
    if (state.currentPage === 'notifications') await loadNotifications();
  } catch (e) {
    toast(e.message, 'warn');
  }
  setTimeout(() => {
    dot.classList.remove('active');
    label.textContent = 'Polling every 15 min';
  }, 2000);
}

/* ── Auto-refresh notifications every 60s ───────────────────────────────── */
setInterval(async () => {
  await loadNotificationCount();
  if (state.currentPage === 'notifications') await loadNotifications();
  if (state.currentPage === 'alerts') await loadAlerts();
}, 60000);

/* ── Helpers ────────────────────────────────────────────────────────────── */
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts.replace(' ', 'T')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ts; }
}

function formatDate(ts) {
  if (!ts) return '';
  try {
    return new Date(ts + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ts; }
}

/* ── Boot ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  // Request notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  await loadLocations();
  await loadAlerts();
  await loadNotificationCount();
  openPage('dashboard');
});