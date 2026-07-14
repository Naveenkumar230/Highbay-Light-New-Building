require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mqtt = require('mqtt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');

const ROWS = 5;
const LIGHTS_PER_ROW = 7;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// ============================================================
//  SITE LABEL -- purely for logging/identification, so it's
//  obvious at a glance which deployment (building) this process
//  and its config.json belong to. Set SITE_NAME in .env.
// ============================================================
const SITE_NAME = process.env.SITE_NAME || '(unnamed site -- set SITE_NAME in .env)';

if (!ADMIN_PASSWORD) {
  console.warn(
    '[WARN] ADMIN_PASSWORD is not set in .env -- the MQTT settings page is DISABLED until you set it. ' +
    'Set ADMIN_USER and ADMIN_PASSWORD in a .env file before exposing this server beyond localhost.'
  );
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function maskSecret(s) {
  return s ? '*'.repeat(Math.min(String(s).length, 8)) : '(empty)';
}

// ============================================================
//  ENV-SEEDED DEFAULTS
//  Each deployment folder (one per building) should have its own
//  .env with MQTT_HOST / MQTT_USERNAME / MQTT_PASSWORD etc. These
//  are used to seed config.json the FIRST time the server runs in
//  a given folder. If you ever copy this project to start a new
//  site, .gitignore keeps config.json out of git -- but a plain
//  folder copy WILL bring an old config.json along with it. If
//  that happens the loud banner below (and the mismatch warning)
//  is what will catch it, so read it on every restart.
// ============================================================
function envDefaults() {
  return {
    host: process.env.MQTT_HOST || '',
    port: parseInt(process.env.MQTT_PORT, 10) || 8883,
    protocol: process.env.MQTT_PROTOCOL || 'mqtts',
    username: process.env.MQTT_USERNAME || '',
    password: process.env.MQTT_PASSWORD || '',
    rejectUnauthorized: process.env.MQTT_REJECT_UNAUTHORIZED !== 'false'
  };
}

// ============================================================
//  CONFIG (MQTT broker settings) -- persisted to config.json
//  config.json is gitignored; secrets never touch source control
// ============================================================
function loadConfig() {
  const defaults = envDefaults();

  if (!fs.existsSync(CONFIG_PATH)) {
    if (defaults.host) {
      log('[CONFIG] No config.json found -- seeding it from .env for site:', SITE_NAME);
      saveConfig(defaults);
      return defaults;
    }
    log('[CONFIG] No config.json and no MQTT_* vars in .env -- starting unconfigured.');
    return {
      host: '', port: 8883, protocol: 'mqtts',
      username: '', password: '', rejectUnauthorized: true
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const cfg = {
      host: raw.host || '',
      port: parseInt(raw.port, 10) || 8883,
      protocol: raw.protocol || 'mqtts',
      username: raw.username || '',
      password: raw.password || '',
      rejectUnauthorized: raw.rejectUnauthorized !== false
    };

    // Safety net: if this folder's .env clearly belongs to a different
    // broker than the config.json sitting next to it, that's exactly the
    // "copied the whole project folder" mistake -- warn loudly instead of
    // silently connecting to whichever one loadConfig() picks.
    if (defaults.host && defaults.host !== cfg.host) {
      console.warn(
        '\n' +
        '################################################################\n' +
        '#  WARNING: config.json host does NOT match MQTT_HOST in .env  #\n' +
        `#  .env (MQTT_HOST)   : ${defaults.host}\n` +
        `#  config.json (host) : ${cfg.host}\n` +
        '#  This usually means config.json was copied over from another #\n' +
        '#  site/deployment. The server will use config.json below --   #\n' +
        '#  delete it if you meant to use the .env values instead.      #\n' +
        '################################################################\n'
      );
    }

    return cfg;
  } catch (e) {
    log('[CONFIG] config.json exists but is invalid JSON, falling back to .env defaults.');
    return defaults;
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

let config = loadConfig();

// ============================================================
//  STATE STORE -- in-memory snapshot of every light
//  key format: "r-l" using human numbers (row 1-5, light 1-7)
// ============================================================
const state = {};
for (let r = 1; r <= ROWS; r++) {
  for (let l = 1; l <= LIGHTS_PER_ROW; l++) {
    state[`${r}-${l}`] = {
      row: r,
      light: l,
      on: false,
      online: false,
      lastSeen: null,
      on_seconds: null,
      off_seconds: null,
      kwh: null,
      rssi: null,
      firmware: null
    };
  }
}

// ============================================================
//  SSE CLIENTS -- push live updates to the browser
// ============================================================
const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ============================================================
//  MQTT CLIENT
// ============================================================
let client = null;
let mqttStatus = 'disconnected';
let reconnectGuard = false;

function topicForSingleCommand(rTopicIdx, lTopicIdx) {
  return `aipl/row/${rTopicIdx}/light/${lTopicIdx}/command`;
}
function topicForRowCommand(rTopicIdx) {
  return `aipl/row/${rTopicIdx}/command`;
}
const TOPIC_ALL_COMMAND = 'aipl/all/command';

// Firmware uses 0-indexed row/light inside topics (ROW_INDEX = char-'1').
// UI uses human numbers (row 1-5, light 1-7). Convert human -> topic index.
function toTopicIdx(n) {
  return n - 1;
}

function connectMQTT() {
  if (reconnectGuard) return;
  reconnectGuard = true;

  if (client) {
    try { client.removeAllListeners(); client.end(true); } catch (e) { /* noop */ }
    client = null;
  }

  if (!config.host) {
    mqttStatus = 'not-configured';
    broadcast('mqtt-status', { status: mqttStatus });
    reconnectGuard = false;
    log(`[MQTT] Not configured for site "${SITE_NAME}" -- set MQTT_HOST in .env or use /admin.html`);
    return;
  }

  mqttStatus = 'connecting';
  broadcast('mqtt-status', { status: mqttStatus });

  // Loud, unmissable, every single connect attempt -- this is the line to
  // check first any time a dashboard seems to be controlling the wrong
  // building's lights.
  log(
    `[MQTT] Connecting  site="${SITE_NAME}"  host=${config.host}:${config.port}  ` +
    `user=${config.username || '(none)'}  pass=${maskSecret(config.password)}`
  );

  try {
    client = mqtt.connect({
      host: config.host,
      port: config.port,
      protocol: config.protocol || 'mqtts',
      username: config.username,
      password: config.password,
      rejectUnauthorized: config.rejectUnauthorized !== false,
      clientId: 'aipl-dashboard-' + crypto.randomBytes(4).toString('hex'),
      reconnectPeriod: 4000,
      connectTimeout: 15000
    });
  } catch (e) {
    log('[MQTT] connect() threw:', e.message);
    mqttStatus = 'error';
    broadcast('mqtt-status', { status: mqttStatus, error: e.message });
    reconnectGuard = false;
    return;
  }

  client.on('connect', () => {
    mqttStatus = 'connected';
    log(`[MQTT] Connected  site="${SITE_NAME}"  host=${config.host}`);
    client.subscribe('aipl/row/+/light/+/state', { qos: 1 });
    client.subscribe('aipl/row/+/light/+/telemetry', { qos: 0 });
    broadcast('mqtt-status', { status: mqttStatus });
    reconnectGuard = false;
  });

  client.on('reconnect', () => {
    mqttStatus = 'connecting';
    broadcast('mqtt-status', { status: mqttStatus });
  });

  client.on('close', () => {
    if (mqttStatus !== 'not-configured') mqttStatus = 'disconnected';
    broadcast('mqtt-status', { status: mqttStatus });
  });

  client.on('error', (err) => {
    mqttStatus = 'error';
    log('[MQTT] Error:', err.message);
    broadcast('mqtt-status', { status: mqttStatus, error: err.message });
  });

  client.on('message', (topic, payloadBuf) => {
    const payload = payloadBuf.toString();
    const stateMatch = topic.match(/^aipl\/row\/(\d+)\/light\/(\d+)\/state$/);
    const teleMatch = topic.match(/^aipl\/row\/(\d+)\/light\/(\d+)\/telemetry$/);

    if (stateMatch) {
      const r = parseInt(stateMatch[1], 10) + 1; // topic idx -> human
      const l = parseInt(stateMatch[2], 10) + 1;
      const key = `${r}-${l}`;
      if (!state[key]) return;
      state[key].on = (payload === 'ON' || payload === 'true' || payload === '1');
      // NOTE: the state topic is published with retain:true by the firmware,
      // so the broker replays the last known value the moment we subscribe --
      // even if that device is powered off right now. Don't treat this as
      // proof of "online"; only live telemetry (below) does that.
      broadcast('light-update', state[key]);
    }

    if (teleMatch) {
      const r = parseInt(teleMatch[1], 10) + 1;
      const l = parseInt(teleMatch[2], 10) + 1;
      const key = `${r}-${l}`;
      if (!state[key]) return;
      try {
        const doc = JSON.parse(payload);
        state[key].on = !!doc.light_state;
        state[key].online = true;
        state[key].lastSeen = Date.now();
        state[key].on_seconds = typeof doc.on_seconds === 'number' ? doc.on_seconds : state[key].on_seconds;
        state[key].off_seconds = typeof doc.off_seconds === 'number' ? doc.off_seconds : state[key].off_seconds;
        state[key].kwh = typeof doc.kwh_used === 'number' ? doc.kwh_used : state[key].kwh;
        state[key].rssi = typeof doc.rssi === 'number' ? doc.rssi : state[key].rssi;
        state[key].firmware = typeof doc.firmware === 'string' ? doc.firmware : state[key].firmware;
        broadcast('light-update', state[key]);
      } catch (e) {
        // malformed telemetry payload -- ignore silently, device will retry in 5s
      }
    }
  });
}

// Mark lights offline if nothing heard for a while
const OFFLINE_AFTER_MS = 30000;
const offlineCheckTimer = setInterval(() => {
  const now = Date.now();
  for (const s of Object.values(state)) {
    if (s.online && s.lastSeen && now - s.lastSeen > OFFLINE_AFTER_MS) {
      s.online = false;
      broadcast('light-update', s);
    }
  }
}, 10000);

connectMQTT();

// ============================================================
//  AUTH -- protects the MQTT settings panel only
// ============================================================
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      error: 'Admin panel is disabled: set ADMIN_USER and ADMIN_PASSWORD in your .env file.'
    });
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sepIdx = decoded.indexOf(':');
    const user = decoded.slice(0, sepIdx);
    const pass = decoded.slice(sepIdx + 1);
    if (timingSafeEqual(user, ADMIN_USER) && timingSafeEqual(pass, ADMIN_PASSWORD)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="AIPL Admin"');
  return res.status(401).json({ error: 'Authentication required' });
}

// ============================================================
//  EXPRESS APP
// ============================================================
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: '10kb' }));

const controlLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' }
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again in a minute.' }
});

// admin.html itself contains no secrets -- it's gated by requiring
// Authorization on /api/config below, so the page can load statically.
app.use(express.static(path.join(__dirname, 'public')));

// ---- live updates (Server-Sent Events) ----
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ---- full status snapshot ----
app.get('/api/status', (req, res) => {
  res.json({
    site: SITE_NAME,
    mqttStatus,
    rows: ROWS,
    lightsPerRow: LIGHTS_PER_ROW,
    lights: Object.values(state)
  });
});

function isValidRow(row) {
  return Number.isInteger(row) && row >= 1 && row <= ROWS;
}
function isValidLight(light) {
  return Number.isInteger(light) && light >= 1 && light <= LIGHTS_PER_ROW;
}

// ---- control a single light ----
app.post('/api/light/:row/:light', controlLimiter, (req, res) => {
  const row = parseInt(req.params.row, 10);
  const light = parseInt(req.params.light, 10);
  const on = req.body && req.body.on === true;

  if (!isValidRow(row) || !isValidLight(light)) {
    return res.status(400).json({ error: 'invalid row/light' });
  }
  if (!client || mqttStatus !== 'connected') {
    return res.status(503).json({ error: 'mqtt not connected' });
  }

  client.publish(topicForSingleCommand(toTopicIdx(row), toTopicIdx(light)), on ? 'ON' : 'OFF', { qos: 1 }, (err) => {
    if (err) return res.status(502).json({ error: 'publish failed' });
    res.json({ ok: true });
  });
});

// ---- control a whole row ----
app.post('/api/row/:row', controlLimiter, (req, res) => {
  const row = parseInt(req.params.row, 10);
  const on = req.body && req.body.on === true;

  if (!isValidRow(row)) {
    return res.status(400).json({ error: 'invalid row' });
  }
  if (!client || mqttStatus !== 'connected') {
    return res.status(503).json({ error: 'mqtt not connected' });
  }

  client.publish(topicForRowCommand(toTopicIdx(row)), on ? 'ON' : 'OFF', { qos: 1 }, (err) => {
    if (err) return res.status(502).json({ error: 'publish failed' });
    res.json({ ok: true });
  });
});

// ---- control everything ----
app.post('/api/all', controlLimiter, (req, res) => {
  const on = req.body && req.body.on === true;
  if (!client || mqttStatus !== 'connected') {
    return res.status(503).json({ error: 'mqtt not connected' });
  }
  client.publish(TOPIC_ALL_COMMAND, on ? 'ON' : 'OFF', { qos: 1 }, (err) => {
    if (err) return res.status(502).json({ error: 'publish failed' });
    res.json({ ok: true });
  });
});

// ---- MQTT settings: read (password masked) -- admin only ----
app.get('/api/config', adminLimiter, requireAdminAuth, (req, res) => {
  res.json({
    site: SITE_NAME,
    host: config.host,
    port: config.port,
    protocol: config.protocol,
    username: config.username,
    password: config.password ? '********' : '',
    rejectUnauthorized: config.rejectUnauthorized !== false,
    mqttStatus
  });
});

// ---- MQTT settings: update + reconnect -- admin only ----
app.post('/api/config', adminLimiter, requireAdminAuth, (req, res) => {
  const { host, port, protocol, username, password, rejectUnauthorized } = req.body || {};

  const portNum = parseInt(port, 10);
  const allowedProtocols = ['mqtt', 'mqtts', 'ws', 'wss'];

  if (!host || typeof host !== 'string' || host.length > 255) {
    return res.status(400).json({ error: 'a valid host is required' });
  }
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return res.status(400).json({ error: 'a valid port is required' });
  }
  if (protocol && !allowedProtocols.includes(protocol)) {
    return res.status(400).json({ error: 'invalid protocol' });
  }

  config = {
    host: host.trim(),
    port: portNum,
    protocol: protocol || 'mqtts',
    username: typeof username === 'string' ? username : '',
    password: password === '********' ? config.password : (typeof password === 'string' ? password : ''),
    rejectUnauthorized: rejectUnauthorized !== false
  };

  try {
    saveConfig(config);
  } catch (e) {
    log('[CONFIG] Failed to save config.json:', e.message);
    return res.status(500).json({ error: 'failed to persist config' });
  }

  connectMQTT();
  log(`[CONFIG] Updated by admin for site "${SITE_NAME}", reconnecting to`, config.host);
  res.json({ ok: true });
});

// ---- 404 for unknown API routes ----
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

// ---- centralized error handler ----
app.use((err, req, res, next) => {
  log('[ERROR]', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(
    '\n' +
    '================================================================\n' +
    `  AIPL dashboard  --  SITE: ${SITE_NAME}\n` +
    `  http://localhost:${PORT}\n` +
    `  MQTT host configured: ${config.host || '(none -- unconfigured)'}\n` +
    '================================================================\n'
  );
  if (!ADMIN_PASSWORD) {
    log('[HTTP] Admin panel is currently disabled (no ADMIN_PASSWORD set).');
  }
});

// ============================================================
//  GRACEFUL SHUTDOWN
// ============================================================
function shutdown(signal) {
  log(`[SYSTEM] ${signal} received, shutting down...`);
  clearInterval(offlineCheckTimer);
  for (const res of sseClients) {
    try { res.end(); } catch (e) { /* noop */ }
  }
  server.close(() => {
    if (client) {
      try { client.end(true, {}, () => process.exit(0)); } catch (e) { process.exit(0); }
    } else {
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log('[FATAL] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  log('[FATAL] Unhandled rejection:', reason);
});