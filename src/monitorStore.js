'use strict';

const MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);


function createMonitor(id, timeout, alertEmail) {
  const monitor = {
    id,
    timeout, // seconds
    alertEmail,
    status: 'active',
    lastHeartbeatAt: null, 
    expiresAt: null,
    downSince: null,
    timer: null,
  };
  startCountdown(monitor);
  return monitor;
}

function recordHeartbeat(monitor) {
  monitor.lastHeartbeatAt = Date.now();
  startCountdown(monitor);
}

function pauseMonitor(monitor) {
  clearCountdown(monitor);
  monitor.status = 'paused';
  monitor.downSince = null;
}

function startCountdown(monitor) {
  
  clearCountdown(monitor);

  const timeoutMs = Math.round(monitor.timeout * 1000);
  monitor.status = 'active';
  monitor.downSince = null;
  monitor.expiresAt = Date.now() + timeoutMs;
  monitor.timer = setTimeout(() => markDown(monitor), timeoutMs);
}

function clearCountdown(monitor) {
  clearTimeout(monitor.timer);
  monitor.timer = null;
  monitor.expiresAt = null;
}

function markDown(monitor) {
  clearCountdown(monitor);
  monitor.status = 'down';
  monitor.downSince = Date.now();

  const alert = {
    ALERT: `Device ${monitor.id} is down!`,
    time: new Date(monitor.downSince).toISOString(),
  };
  console.log(JSON.stringify(alert));
}

function toIsoString(timestamp) {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}


function toMonitorResponse(monitor) {
  const timeRemaining =
    monitor.expiresAt === null ? null : Math.max(0, monitor.expiresAt - Date.now()) / 1000;

  return {
    id: monitor.id,
    status: monitor.status,
    timeout: monitor.timeout,
    alert_email: monitor.alertEmail,
    last_heartbeat_at: toIsoString(monitor.lastHeartbeatAt),
    expires_at: toIsoString(monitor.expiresAt),
    time_remaining: timeRemaining,
    down_since: toIsoString(monitor.downSince),
  };
}

module.exports = {
  MAX_TIMEOUT_SECONDS,
  createMonitor,
  recordHeartbeat,
  pauseMonitor,
  clearCountdown,
  toMonitorResponse,
};
