'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createMonitor,
  recordHeartbeat,
  pauseMonitor,
  toMonitorResponse,
} = require('../src/monitorStore');

const SIXTY_SECONDS_MS = 60_000;


function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const consoleLog = t.mock.method(console, 'log', () => {});
  const monitor = createMonitor('device-123', 60, 'admin@critmon.com');
  return { monitor, consoleLog };
}

describe('User Story 1: registering a monitor', () => {
  it('starts a 60-second countdown', (t) => {
    const { monitor, consoleLog } = setup(t);

    assert.equal(monitor.status, 'active');
    assert.equal(toMonitorResponse(monitor).expires_at, '1970-01-01T00:01:00.000Z');
    assert.equal(toMonitorResponse(monitor).time_remaining, 60);

    t.mock.timers.tick(SIXTY_SECONDS_MS - 1);
    assert.equal(monitor.status, 'active');
    assert.equal(consoleLog.mock.callCount(), 0);
  });
});

describe('User Story 2: heartbeat', () => {
  it('restarts the countdown from the beginning', (t) => {
    const { monitor, consoleLog } = setup(t);

    t.mock.timers.tick(45_000);
    recordHeartbeat(monitor);
    assert.equal(toMonitorResponse(monitor).time_remaining, 60);
    assert.equal(toMonitorResponse(monitor).last_heartbeat_at, '1970-01-01T00:00:45.000Z');

    
    t.mock.timers.tick(SIXTY_SECONDS_MS - 1);
    assert.equal(monitor.status, 'active');
    assert.equal(consoleLog.mock.callCount(), 0);

    t.mock.timers.tick(1);
    assert.equal(monitor.status, 'down');
  });
});

describe('User Story 3: alert when the countdown reaches zero', () => {
  it('logs the alert JSON with console.log and changes the status to down', (t) => {
    const { monitor, consoleLog } = setup(t);

    t.mock.timers.tick(SIXTY_SECONDS_MS);

    assert.equal(consoleLog.mock.callCount(), 1);
    assert.equal(
      consoleLog.mock.calls[0].arguments[0],
      '{"ALERT":"Device device-123 is down!","time":"1970-01-01T00:01:00.000Z"}',
    );
    assert.equal(monitor.status, 'down');
    assert.equal(toMonitorResponse(monitor).down_since, '1970-01-01T00:01:00.000Z');
  });

  it('logs the alert only once per expiry', (t) => {
    const { consoleLog } = setup(t);

    t.mock.timers.tick(10 * SIXTY_SECONDS_MS);

    assert.equal(consoleLog.mock.callCount(), 1);
  });

  it('a heartbeat on a down monitor recovers it and starts a new countdown', (t) => {
    const { monitor, consoleLog } = setup(t);
    t.mock.timers.tick(SIXTY_SECONDS_MS);

    recordHeartbeat(monitor);
    assert.equal(monitor.status, 'active');
    assert.equal(toMonitorResponse(monitor).down_since, null);

    t.mock.timers.tick(SIXTY_SECONDS_MS);
    assert.equal(consoleLog.mock.callCount(), 2);
  });
});

describe('Bonus: pause (snooze)', () => {
  it('stops the countdown completely so no alert fires', (t) => {
    const { monitor, consoleLog } = setup(t);

    t.mock.timers.tick(30_000);
    pauseMonitor(monitor);
    t.mock.timers.tick(100 * SIXTY_SECONDS_MS);

    assert.equal(consoleLog.mock.callCount(), 0);
    assert.equal(monitor.status, 'paused');
    assert.equal(toMonitorResponse(monitor).time_remaining, null);
  });

  it('the next heartbeat un-pauses the monitor and restarts the full countdown', (t) => {
    const { monitor, consoleLog } = setup(t);

    pauseMonitor(monitor);
    t.mock.timers.tick(5 * SIXTY_SECONDS_MS);
    recordHeartbeat(monitor);
    assert.equal(monitor.status, 'active');

    t.mock.timers.tick(SIXTY_SECONDS_MS - 1);
    assert.equal(consoleLog.mock.callCount(), 0);

    t.mock.timers.tick(1);
    assert.equal(consoleLog.mock.callCount(), 1);
    assert.equal(monitor.status, 'down');
  });
});
