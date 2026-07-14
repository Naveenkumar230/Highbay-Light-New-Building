const ROWS = 5;
const LIGHTS_PER_ROW = 7;

// ---------- high-bay fixture markup ----------
// Same fixture for every light. State (on / off / offline) is driven purely
// by CSS classes on the .light-btn wrapper -- see .light-btn.on / .offline
// rules in style.css -- so this template never needs to change per state.
function fixtureSvg() {
  return `
    <svg class="fixture" width="64" height="92" viewBox="0 0 90 140" aria-hidden="true">
      <line class="rod" x1="45" y1="0" x2="45" y2="18"/>
      <path class="dome" d="M20 34 C20 16 70 16 70 34 L70 40 L20 40 Z"/>
      <rect class="wood-band" x="30" y="38" width="30" height="10" rx="1"/>
      <path class="shade" d="M24 48 L66 48 L80 84 L10 84 Z"/>
      <g class="light-cone">
        <polygon class="cone-3" points="4,84 86,84 90,140 0,140"/>
        <polygon class="cone-2" points="12,84 78,84 86,120 4,120"/>
        <polygon class="cone-1" points="20,84 70,84 78,104 12,104"/>
      </g>
      <ellipse class="rim" cx="45" cy="84" rx="35" ry="7"/>
    </svg>`;
}

// const OFFLINE_ICON = `<svg viewBox="0 0 24 24"><path d="M12 9v4"/><path d="M12 16.5v.01"/><path d="M10.3 3.9 1.8 18a1.8 1.8 0 0 0 1.55 2.7h17.3A1.8 1.8 0 0 0 22.2 18L13.7 3.9a1.8 1.8 0 0 0-3.4 0z"/></svg>`;

const rowsContainer = document.getElementById('rowsContainer');
const mqttDot = document.getElementById('mqttDot');
const mqttText = document.getElementById('mqttText');

// ---------- build the grid ----------
function buildGrid() {
  for (let r = 1; r <= ROWS; r++) {
    const card = document.createElement('section');
    card.className = 'row-card';

    const header = document.createElement('div');
    header.className = 'row-card-header';
    header.innerHTML = `
      <span class="row-title">Row ${r}</span>
      <div class="row-actions">
        <button data-row="${r}" data-on="1">ON</button>
        <button data-row="${r}" data-on="0">OFF</button>
      </div>`;
    card.appendChild(header);

    const lightsRow = document.createElement('div');
    lightsRow.className = 'lights-row';

    for (let l = 1; l <= LIGHTS_PER_ROW; l++) {
      const unit = document.createElement('div');
      unit.className = 'light-unit';
      unit.id = `unit-${r}-${l}`;
      unit.innerHTML = `
  <button class="light-btn" id="btn-${r}-${l}" data-row="${r}" data-light="${l}">
    ${fixtureSvg()}
  </button>
  <span class="light-label">Light ${l}</span>`;
      lightsRow.appendChild(unit);
    }

    card.appendChild(lightsRow);
    rowsContainer.appendChild(card);
  }
}
buildGrid();

// ---------- click handlers (event delegation) ----------
rowsContainer.addEventListener('click', (e) => {
  const lightBtn = e.target.closest('.light-btn');
  if (lightBtn) {
    const row = lightBtn.dataset.row;
    const light = lightBtn.dataset.light;
    const turningOn = !lightBtn.classList.contains('on');
    setLightOptimistic(row, light, turningOn);
    fetch(`/api/light/${row}/${light}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: turningOn })
    }).catch(() => {});
    return;
  }

  const rowBtn = e.target.closest('.row-actions button');
  if (rowBtn) {
    const row = rowBtn.dataset.row;
    const on = rowBtn.dataset.on === '1';
    for (let l = 1; l <= LIGHTS_PER_ROW; l++) setLightOptimistic(row, l, on);
    fetch(`/api/row/${row}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on })
    }).catch(() => {});
  }
});

document.getElementById('allOnBtn').addEventListener('click', () => sendAll(true));
document.getElementById('allOffBtn').addEventListener('click', () => sendAll(false));

function sendAll(on) {
  for (let r = 1; r <= ROWS; r++)
    for (let l = 1; l <= LIGHTS_PER_ROW; l++) setLightOptimistic(r, l, on);
  fetch('/api/all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on })
  }).catch(() => {});
}

function setLightOptimistic(row, light, on) {
  const btn = document.getElementById(`btn-${row}-${light}`);
  if (!btn) return;
  btn.classList.toggle('on', on);
}

function applyLightState(s) {
  const btn = document.getElementById(`btn-${s.row}-${s.light}`);
  if (!btn) return;
  btn.classList.toggle('on', !!s.on);
}

// ---------- initial load ----------
fetch('/api/status')
  .then(r => r.json())
  .then(data => {
    setMqttStatus(data.mqttStatus);
    data.lights.forEach(applyLightState);
  })
  .catch(() => setMqttStatus('server-unreachable'));

// ---------- live updates via SSE ----------
const events = new EventSource('/api/events');
events.addEventListener('light-update', (e) => {
  applyLightState(JSON.parse(e.data));
});
events.addEventListener('mqtt-status', (e) => {
  setMqttStatus(JSON.parse(e.data).status);
});

// If the SSE connection itself drops (server crashed, host offline,
// network gone) the browser doesn't tell us anything useful by default --
// the dot just freezes on its last value. Treat onerror as "server gone"
// until the browser's auto-reconnect succeeds (the 'open' handler below
// will then re-sync to the real status).
events.addEventListener('error', () => {
  setMqttStatus('server-unreachable');
});
events.addEventListener('open', () => {
  // connection (re)established -- pull a fresh snapshot since we may have
  // missed light-update / mqtt-status events while disconnected
  fetch('/api/status')
    .then(r => r.json())
    .then(data => {
      setMqttStatus(data.mqttStatus);
      data.lights.forEach(applyLightState);
    })
    .catch(() => setMqttStatus('server-unreachable'));
});

// ---------- fallback health check ----------
// Belt-and-suspenders: poll /api/status periodically in case SSE is in a
// reconnect loop the browser hasn't surfaced yet. Cheap, and catches the
// case where the server process is up but wedged.
setInterval(() => {
  fetch('/api/status', { cache: 'no-store' })
    .then(r => {
      if (!r.ok) throw new Error('bad status');
      return r.json();
    })
    .then(data => setMqttStatus(data.mqttStatus))
    .catch(() => setMqttStatus('server-unreachable'));
}, 15000);

function setMqttStatus(status) {
  mqttDot.className = 'dot ' + status;
  const labels = {
    connected: 'connected',
    connecting: 'connecting…',
    disconnected: 'disconnected',
    error: 'error',
    'not-configured': 'not configured',
    'server-unreachable': 'offline'
  };
  mqttText.textContent = labels[status] || status;
}

// ---------- apply saved UI accent theme ----------
const savedUiTheme = localStorage.getItem('aipl-ui-theme') || 'classic-green';
document.documentElement.setAttribute('data-ui-theme', savedUiTheme);

// ---------- theme toggle ----------
const themeToggle = document.getElementById('themeToggle');
const sunIcon = document.getElementById('themeIconSun');
const moonIcon = document.getElementById('themeIconMoon');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  sunIcon.style.display = theme === 'dark' ? 'none' : 'block';
  moonIcon.style.display = theme === 'dark' ? 'block' : 'none';
  localStorage.setItem('aipl-theme', theme);
}

const savedTheme = localStorage.getItem('aipl-theme') ||
  (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(savedTheme);

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});