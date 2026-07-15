const ROWS = 5;
const LIGHTS_PER_ROW = 7;

const rowsContainer = document.getElementById('rowsContainer');
const mqttDot = document.getElementById('mqttDot');
const mqttText = document.getElementById('mqttText');
const statOnCount = document.getElementById('statOnCount');
const statRowCount = document.getElementById('statRowCount');
const statOfflineCount = document.getElementById('statOfflineCount');

// ---------- bulb icon (single shared markup, state driven by CSS class) ----------
function bulbSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.45 1.1 1.1 1.1 1.9V16h5v-.3c0-.8.5-1.45 1.1-1.9A6 6 0 0 0 12 3z"/>
  </svg>`;
}

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
        <button data-row="${r}" data-on="1">On</button>
        <button data-row="${r}" data-on="0">Off</button>
      </div>`;
    card.appendChild(header);

    const lightsRow = document.createElement('div');
    lightsRow.className = 'lights-row';

    for (let l = 1; l <= LIGHTS_PER_ROW; l++) {
      const unit = document.createElement('div');
      unit.className = 'light-unit';
      unit.id = `unit-${r}-${l}`;
      unit.innerHTML = `
  <button class="light-btn" id="btn-${r}-${l}" data-row="${r}" data-light="${l}" aria-label="Light ${l}, row ${r}">
    ${bulbSvg()}
  </button>
  <span class="light-label">Light ${l}</span>`;
      lightsRow.appendChild(unit);
    }

    card.appendChild(lightsRow);
    rowsContainer.appendChild(card);
  }
  statRowCount.textContent = ROWS;
}
buildGrid();

// ---------- summary stats ----------
function updateSummary() {
  const all = document.querySelectorAll('.light-btn');
  const on = document.querySelectorAll('.light-btn.on:not(.offline)');
  const offline = document.querySelectorAll('.light-btn.offline');
  statOnCount.textContent = `${on.length}/${all.length}`;
  statOfflineCount.textContent = offline.length;
}

// ---------- click handlers (event delegation) ----------
rowsContainer.addEventListener('click', (e) => {
  const lightBtn = e.target.closest('.light-btn');
  if (lightBtn) {
    if (lightBtn.classList.contains('offline')) return; // can't toggle a light with no signal
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
  if (!btn || btn.classList.contains('offline')) return;
  btn.classList.toggle('on', on);
  updateSummary();
}

function applyLightState(s) {
  const btn = document.getElementById(`btn-${s.row}-${s.light}`);
  if (!btn) return;
  btn.classList.toggle('offline', !!s.offline);
  btn.classList.toggle('on', !!s.on);
  updateSummary();
}

// ---------- initial load ----------
fetch('/api/status')
  .then(r => r.json())
  .then(data => {
    setMqttStatus(data.mqttStatus);
    data.lights.forEach(applyLightState);
    updateSummary();
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
      updateSummary();
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

// ---------- logout ----------
document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('aipl-auth');
  window.location.replace('login.html');
});