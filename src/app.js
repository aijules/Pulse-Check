'use strict';

const {
  MAX_TIMEOUT_SECONDS,
  createMonitor,
  recordHeartbeat,
  pauseMonitor,
  toMonitorResponse,
} = require('./monitorStore');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


const MONITOR_PATH = /^\/monitors\/([^/]+)(?:\/(heartbeat|pause))?$/;

// Keyed by the status the monitor had *before* the heartbeat arrived.
const HEARTBEAT_MESSAGES = {
  active: 'Heartbeat received.',
  paused: 'Heartbeat received. Monitor un-paused.',
  down: 'Heartbeat received. Monitor recovered from down.',
};

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}


function validateRegistration(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.';
  }
  if (typeof body.id !== 'string' || body.id.trim() === '') {
    return '"id" must be a non-empty string.';
  }
  if (!Number.isFinite(body.timeout) || body.timeout <= 0 || body.timeout > MAX_TIMEOUT_SECONDS) {
    return `"timeout" must be a number of seconds greater than 0 and at most ${MAX_TIMEOUT_SECONDS}.`;
  }
  if (typeof body.alert_email !== 'string' || !EMAIL_PATTERN.test(body.alert_email)) {
    return '"alert_email" must be a valid email address.';
  }
  return null;
}

async function handleRegister(req, res, monitors) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Request body must be valid JSON.' });
  }

  const validationError = validateRegistration(body);
  if (validationError) {
    return sendJson(res, 400, { error: validationError });
  }
  if (monitors.has(body.id)) {
    return sendJson(res, 409, { error: `Monitor '${body.id}' already exists.` });
  }

  const monitor = createMonitor(body.id, body.timeout, body.alert_email);
  monitors.set(monitor.id, monitor);

  sendJson(res, 201, {
    message: `Monitor '${monitor.id}' registered. ${monitor.timeout}-second countdown started.`,
    monitor: toMonitorResponse(monitor),
  });
}

function handleHeartbeat(res, monitor) {
  const message = HEARTBEAT_MESSAGES[monitor.status];
  recordHeartbeat(monitor);

  sendJson(res, 200, {
    message: `${message} ${monitor.timeout}-second countdown restarted.`,
    monitor: toMonitorResponse(monitor),
  });
}

function handlePause(res, monitor) {
  pauseMonitor(monitor);

  sendJson(res, 200, {
    message: `Monitor '${monitor.id}' paused. No alerts will fire until the next heartbeat.`,
    monitor: toMonitorResponse(monitor),
  });
}

async function routeRequest(req, res, monitors) {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/' && req.method === 'GET') {
    return sendJson(res, 200, {
      service: 'Pulse-Check API',
      status: 'ok',
      docs: 'https://github.com/aijules/Pulse-Check#3-api-documentation',
    });
  }

  if (pathname === '/monitors' && req.method === 'POST') {
    return handleRegister(req, res, monitors);
  }

  const match = MONITOR_PATH.exec(pathname);
  if (!match) {
    return sendJson(res, 404, { error: 'Route not found.' });
  }

  const [, encodedId, action] = match;
  const expectedMethod = action ? 'POST' : 'GET';
  if (req.method !== expectedMethod) {
    return sendJson(res, 404, { error: 'Route not found.' });
  }

  let id;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return sendJson(res, 400, { error: 'Malformed monitor id in URL.' });
  }

  const monitor = monitors.get(id);
  if (!monitor) {
    return sendJson(res, 404, { error: `Monitor '${id}' not found.` });
  }

  if (action === 'heartbeat') {
    return handleHeartbeat(res, monitor);
  }
  if (action === 'pause') {
    return handlePause(res, monitor);
  }
  return sendJson(res, 200, toMonitorResponse(monitor));
}

// `monitors` is the in-memory Map of monitor id -> monitor.
function createApp(monitors) {
  return async function handleRequest(req, res) {
    try {
      await routeRequest(req, res, monitors);
    } catch (err) {
      // An uncaught error would crash the process and silently stop every
      // monitor's countdown, so answer with 500 and keep running.
      console.error('Unexpected error while handling request:', err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error.' });
      }
    }
  };
}

module.exports = { createApp };
