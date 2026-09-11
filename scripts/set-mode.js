#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadState, saveState, isListenerAlive, PID_FILE, HEARTBEAT_FILE, DATA_DIR } = require('./telegram-lib');

const LISTENER_SCRIPT = path.join(__dirname, 'telegram-listener.js');
const LISTENER_LOG = path.join(DATA_DIR, 'telegram-listener-output.log');

function startListener() {
  if (isListenerAlive()) {
    console.log('Listener already running.');
    return;
  }
  const out = fs.openSync(LISTENER_LOG, 'a');
  const err = fs.openSync(LISTENER_LOG, 'a');
  const child = spawn(process.execPath, [LISTENER_SCRIPT], {
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  console.log(`Listener started in background (pid ${child.pid}). Logs: ${LISTENER_LOG}`);
}

function stopListener(quiet) {
  let pid = null;
  try {
    pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
  } catch {
    // no pid file
  }
  if (!pid) {
    if (!quiet) console.log('No tracked listener pid — nothing to stop (it may be running in the foreground elsewhere).');
    return;
  }
  try {
    process.kill(pid);
    console.log(`Listener stopped (pid ${pid}).`);
  } catch {
    console.log('Listener was not running (stale pid file).');
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // already gone
  }
  try {
    fs.unlinkSync(HEARTBEAT_FILE); // don't let a stale-but-still-fresh heartbeat report "running"
  } catch {
    // already gone
  }
}

const arg = (process.argv[2] || '').toLowerCase();
const state = loadState();

// Bare invocation (no argument) reports status — it must NEVER silently flip the mode.
// The tg-code wrapper always passes an explicit subcommand ("status"/"local"/"remote"), so
// this only matters for someone running `node set-mode.js` directly; still, a no-arg call
// having a hidden side effect (this used to toggle local<->remote) is exactly the kind of
// surprise that caused real confusion once already — don't reintroduce it.
if (arg === 'status' || arg === '') {
  console.log(`Approval mode: ${state.mode}`);
  process.exit(0);
}

if (arg === 'listener-status') {
  console.log(`Listener: ${isListenerAlive() ? 'running' : 'not running'}`);
  process.exit(0);
}

if (arg === 'listen-start') {
  startListener();
  process.exit(0);
}

if (arg === 'listen-stop') {
  stopListener();
  process.exit(0);
}

let next;
if (arg === 'local' || arg === 'remote') {
  next = arg;
} else {
  console.error('Usage: node set-mode.js [local|remote|status|listener-status|listen-start|listen-stop]  (no arg = status)');
  process.exit(1);
}

saveState({ ...state, mode: next });
console.log(`Approval mode: ${next}`);

if (next === 'remote') {
  startListener();
} else if (next === 'local') {
  stopListener(true);
}
