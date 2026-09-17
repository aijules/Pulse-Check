'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');
const { createApp } = require('../src/app');
const { MAX_TIMEOUT_SECONDS, clearCountdown } = require('../src/monitorStore');

const DEVICE = { id: 'device-123', timeout: 60, alert_email: 'admin@critmon.com' };


async function startServer(t) {
  const monitors = new Map();
  const server = http.createServer(createApp(monitors));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const consoleLog = t.mock.method(console, 'log', () => {});

  t.after(() => {
    for (const monitor of monitors.values()) {
      clearCountdown(monitor);
    }
    return new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // `body` may be an object (sent as JSON) or a raw string (to test bad JSON).
  async function request(method, path, body) {
    const options = { method };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await fetch(baseUrl + path, options);
    return { status: response.status, body: await response.json() };
  }

  function loggedAlerts() {
    return consoleLog.mock.calls.map((call) => JSON.parse(call.arguments[0]));
  }

  return { request, loggedAlerts };
}

describe('User Story 1: POST /monitors', () => {
  it('registers the monitor, starts its countdown and returns 201 Created', async (t) => {
    const { request } = await startServer(t);

    const res = await request('POST', '/monitors', DEVICE);

    assert.equal(res.status, 201);
    assert.equal(res.body.message, "Monitor 'device-123' registered. 60-second countdown started.");
    assert.equal(res.body.monitor.id, 'device-123');
    assert.equal(res.body.monitor.status, 'active');
    assert.equal(res.body.monitor.timeout, 60);
    assert.equal(res.body.monitor.alert_email, 'admin@critmon.com');
    assert.ok(res.body.monitor.time_remaining > 59 && res.body.monitor.time_remaining <= 60);
  });

  it('returns 409 Conflict when the id is already registered', async (t) => {
    const { request } = await startServer(t);
    await request('POST', '/monitors', DEVICE);

    const res = await request('POST', '/monitors', DEVICE);

    assert.equal(res.status, 409);
    assert.equal(res.body.error, "Monitor 'device-123' already exists.");
  });

  const invalidBodies = [
    ['malformed JSON', '{"id": "device-123",'],
    ['an empty body', ''],
    ['a JSON array', []],
    ['a missing id', { timeout: 60, alert_email: 'admin@critmon.com' }],
    ['a blank id', { ...DEVICE, id: '   ' }],
    ['a non-string id', { ...DEVICE, id: 123 }],
    ['a missing timeout', { id: 'device-123', alert_email: 'admin@critmon.com' }],
    ['a string timeout', { ...DEVICE, timeout: '60' }],
    ['a zero timeout', { ...DEVICE, timeout: 0 }],
    ['a negative timeout', { ...DEVICE, timeout: -5 }],
    ['a timeout above the maximum', { ...DEVICE, timeout: MAX_TIMEOUT_SECONDS + 1 }],
    ['a missing alert_email', { id: 'device-123', timeout: 60 }],
    ['an invalid alert_email', { ...DEVICE, alert_email: 'not-an-email' }],
  ];

  for (const [description, body] of invalidBodies) {
    it(`returns 400 Bad Request for ${description}`, async (t) => {
      const { request } = await startServer(t);

      const res = await request('POST', '/monitors', body);

      assert.equal(res.status, 400);
      assert.equal(typeof res.body.error, 'string');
    });
  }
});

describe('User Story 2: POST /monitors/{id}/heartbeat', () => {
  it('restarts the countdown and returns 200 OK', async (t) => {
    const { request } = await startServer(t);
    await request('POST', '/monitors', DEVICE);

    const res = await request('POST', '/monitors/device-123/heartbeat');

    assert.equal(res.status, 200);
    assert.equal(res.body.message, 'Heartbeat received. 60-second countdown restarted.');
    assert.equal(res.body.monitor.status, 'active');
    assert.notEqual(res.body.monitor.last_heartbeat_at, null);
  });

  it('returns 404 Not Found for an unknown id', async (t) => {
    const { request } = await startServer(t);

    const res = await request('POST', '/monitors/ghost-device/heartbeat');

    assert.equal(res.status, 404);
    assert.equal(res.body.error, "Monitor 'ghost-device' not found.");
  });

  it('prevents the alert while heartbeats keep arriving before the timeout', async (t) => {
    const { request, loggedAlerts } = await startServer(t);
    await request('POST', '/monitors', { ...DEVICE, timeout: 0.4 });

    
    for (let i = 0; i < 5; i += 1) {
      await sleep(150);
      await request('POST', '/monitors/device-123/heartbeat');
    }

    assert.equal(loggedAlerts().length, 0);
    assert.equal((await request('GET', '/monitors/device-123')).body.status, 'active');
  });
});

describe('User Story 3: alert when the countdown reaches zero', () => {
  it('logs the alert and changes the monitor status to down', async (t) => {
    const { request, loggedAlerts } = await startServer(t);
    await request('POST', '/monitors', { ...DEVICE, timeout: 0.2 });

    await sleep(450);

    const alerts = loggedAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].ALERT, 'Device device-123 is down!');
    assert.ok(!Number.isNaN(Date.parse(alerts[0].time)));
    assert.equal((await request('GET', '/monitors/device-123')).body.status, 'down');
  });

  it('a heartbeat on a down monitor recovers it', async (t) => {
    const { request } = await startServer(t);
    await request('POST', '/monitors', { ...DEVICE, timeout: 0.2 });
    await sleep(450);

    const res = await request('POST', '/monitors/device-123/heartbeat');

    assert.equal(res.status, 200);
    assert.equal(
      res.body.message,
      'Heartbeat received. Monitor recovered from down. 0.2-second countdown restarted.',
    );
    assert.equal(res.body.monitor.status, 'active');
  });
});

describe('Bonus: POST /monitors/{id}/pause', () => {
  it('stops the countdown so no alert fires, and the next heartbeat un-pauses it', async (t) => {
    const { request, loggedAlerts } = await startServer(t);
    await request('POST', '/monitors', { ...DEVICE, timeout: 0.2 });

    const paused = await request('POST', '/monitors/device-123/pause');
    assert.equal(paused.status, 200);
    assert.equal(paused.body.monitor.status, 'paused');

    await sleep(450);
    assert.equal(loggedAlerts().length, 0);

    const resumed = await request('POST', '/monitors/device-123/heartbeat');
    assert.equal(resumed.status, 200);
    assert.equal(
      resumed.body.message,
      'Heartbeat received. Monitor un-paused. 0.2-second countdown restarted.',
    );

    await sleep(450);
    assert.equal(loggedAlerts().length, 1);
  });

  it('returns 404 Not Found for an unknown id', async (t) => {
    const { request } = await startServer(t);

    const res = await request('POST', '/monitors/ghost-device/pause');

    assert.equal(res.status, 404);
  });
});

describe("Developer's Choice: GET /monitors/{id}", () => {
  it('returns the current state of the monitor', async (t) => {
    const { request } = await startServer(t);
    await request('POST', '/monitors', DEVICE);

    const res = await request('GET', '/monitors/device-123');

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), [
      'id',
      'status',
      'timeout',
      'alert_email',
      'last_heartbeat_at',
      'expires_at',
      'time_remaining',
      'down_since',
    ]);
    assert.equal(res.body.status, 'active');
    assert.ok(res.body.time_remaining > 0 && res.body.time_remaining <= 60);
  });

  it('supports URL-encoded ids', async (t) => {
    const { request } = await startServer(t);
    await request('POST', '/monitors', { ...DEVICE, id: 'solar farm/7' });

    const res = await request('GET', `/monitors/${encodeURIComponent('solar farm/7')}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.id, 'solar farm/7');
  });

  it('returns 404 Not Found for an unknown id', async (t) => {
    const { request } = await startServer(t);

    const res = await request('GET', '/monitors/ghost-device');

    assert.equal(res.status, 404);
  });
});

describe('Unknown routes', () => {
  it('return 404 for unknown paths and unsupported methods', async (t) => {
    const { request } = await startServer(t);
    await request('POST', '/monitors', DEVICE);

    assert.equal((await request('GET', '/nope')).status, 404);
    assert.equal((await request('GET', '/monitors')).status, 404);
    assert.equal((await request('GET', '/monitors/device-123/heartbeat')).status, 404);
    assert.equal((await request('DELETE', '/monitors/device-123')).status, 404);
  });
});
