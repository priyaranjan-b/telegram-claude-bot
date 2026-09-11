'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// When installed as a plugin, hooks.json passes TELEGRAM_OPS_DATA_DIR (resolved from
// ${CLAUDE_PLUGIN_DATA}) so state survives plugin updates — never write it under
// ${CLAUDE_PLUGIN_ROOT} (i.e. __dirname), which gets replaced on every update. Falls
// back to __dirname for standalone / non-plugin use (manual ~/.claude/hooks install).
const DATA_DIR = process.env.TELEGRAM_OPS_DATA_DIR || __dirname;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  // best-effort only
}

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HEARTBEAT_FILE = path.join(DATA_DIR, 'listener-heartbeat.json');
const PID_FILE = path.join(DATA_DIR, 'listener.pid');
const PENDING_DIR = path.join(DATA_DIR, 'pending');
// telegram-listener.js writes a heartbeat once per poll iteration (not on an independent
// timer — see its main loop), and a single getUpdates call can legitimately take up to
// (POLL_SEC + 10) * 1000 = 35000ms before resolving or rejecting. This must stay
// comfortably above that worst case, or a perfectly healthy long-poll makes the listener
// look "dead" for a few seconds every cycle.
const HEARTBEAT_FRESH_MS = 45000;

// Strip a leading UTF-8 BOM — some editors/tools (Notepad, PowerShell's
// Set-Content) write one, and JSON.parse rejects it outright otherwise.
function loadJson(p) {
  try {
    const BOM = String.fromCharCode(0xfeff);
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(new RegExp(`^${BOM}`), ''));
  } catch {
    return null;
  }
}

// Walks up from startDir looking for a `.claude` directory, to find a project root.
function findProjectDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6 && dir; i++) {
    if (fs.existsSync(path.join(dir, '.claude'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

function projectNameFromCwd(cwd) {
  return cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() : '';
}

// Adds `rule` to a permissions.allow list on disk — the project's
// .claude/settings.local.json if a project root is found from `cwd`, else the
// global ~/.claude/settings.json. Creates the file/directory if needed; no-ops if
// the rule is already present.
function appendAllowRule(rule, cwd) {
  const projectDir = cwd ? findProjectDir(cwd) : null;
  const hasProjectClaude = projectDir && fs.existsSync(path.join(projectDir, '.claude'));
  const targetFile = hasProjectClaude
    ? path.join(projectDir, '.claude', 'settings.local.json')
    : path.join(os.homedir(), '.claude', 'settings.json');

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const settings = loadJson(targetFile) || {};
  if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
  if (!settings.permissions.allow.includes(rule)) settings.permissions.allow.push(rule);
  fs.writeFileSync(targetFile, JSON.stringify(settings, null, 2));
  return targetFile;
}

function loadCredentials() {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return { token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID };
  }
  const settings = loadJson(path.join(os.homedir(), '.claude', 'settings.json'));
  const env = (settings && settings.env) || {};
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    return { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
  }
  return { token: null, chatId: null };
}

function writeHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch {
    // best-effort only
  }
}

function isListenerAlive() {
  // If we're tracking a pid (started via `tg-code listen start`), trust that immediately —
  // no need to wait for the heartbeat to go stale after a stop.
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    if (pid) {
      try {
        process.kill(pid, 0); // throws without killing anything if the pid isn't running
      } catch {
        return false;
      }
    }
  } catch {
    // no pid file — may be running untracked in a foreground terminal, fall through
  }
  try {
    const hb = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
    return Date.now() - hb.ts < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      mode: s.mode === 'remote' ? 'remote' : 'local',
      offset: Number.isInteger(s.offset) ? s.offset : 0,
    };
  } catch {
    return { mode: 'local', offset: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function apiRequest(token, method, params, timeoutMs) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.telegram.org/bot${token}/${method}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(body)}`);
  return body.result;
}

// Defense in depth for the plaintext debug logs: the bot token is embedded directly in
// every Telegram API request URL, so a raw low-level fetch/network error could in
// principle echo it back in its message. Scrub it out before anything gets logged.
function redactSecret(secret, text) {
  if (!secret) return text;
  return String(text).split(secret).join('[REDACTED]');
}

// Telegram bot messages don't support custom font colors — bold/italic/monospace
// plus emoji are the closest practical substitute, and that's what these send with.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sendMessage(token, chatId, text, replyMarkup) {
  const params = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: 'true' };
  if (replyMarkup) params.reply_markup = JSON.stringify(replyMarkup);
  return apiRequest(token, 'sendMessage', params, 15000);
}

// Multipart upload — FormData/Blob are Node 18+ globals, so this stays dependency-free.
async function sendDocument(token, chatId, filename, content, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([content], { type: 'text/plain' }), filename);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram sendDocument failed: ${JSON.stringify(body)}`);
  return body.result;
}

function editMessageText(token, chatId, messageId, text) {
  return apiRequest(
    token,
    'editMessageText',
    { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' },
    10000
  );
}

function answerCallbackQuery(token, callbackQueryId, text) {
  return apiRequest(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '' }, 10000);
}

function getUpdates(token, offset, timeoutSec) {
  return apiRequest(
    token,
    'getUpdates',
    {
      offset: String(offset),
      timeout: String(timeoutSec),
      allowed_updates: JSON.stringify(['message', 'callback_query']),
    },
    (timeoutSec + 10) * 1000
  );
}

// Inline keyboard for an approval prompt tied to one request id, so a tap always
// resolves the exact request it was shown for — never "whichever is oldest". The
// "always allow" row is omitted for ExitPlanMode — blanket-approving all future
// plans without asking is a real safety regression, not just a convenience.
function buildApprovalKeyboard(requestId, toolName) {
  const rows = [
    [
      { text: 'YES', callback_data: `allow|${requestId}` },
      { text: 'NO', callback_data: `deny|${requestId}` },
    ],
  ];
  if (toolName !== 'ExitPlanMode') {
    rows.push([{ text: '✅ Always allow this', callback_data: `alwaysallow|${requestId}` }]);
  }
  rows.push([{ text: 'Switch to local mode', callback_data: `local|${requestId}` }]);
  return { inline_keyboard: rows };
}

// Parses a typed Telegram reply. Supports bare yes/no/approve/deny/allow/reject,
// "yes: <reason>" / "no: <reason>" for an explained decision, and /local /remote /status.
function parseReplyText(text) {
  const t = (text || '').trim();
  const lower = t.toLowerCase();

  if (lower === '/local') return { type: 'local' };
  if (lower === '/remote') return { type: 'remote' };
  if (lower === '/status') return { type: 'status' };

  if (/^(?:yes|y|approve|allow)$/.test(lower)) return { type: 'allow', reason: 'Approved via Telegram' };
  if (/^(?:no|n|deny|reject)$/.test(lower)) return { type: 'deny', reason: 'Denied via Telegram' };

  let m = /^(?:yes|y)\s*[:\-]\s*(.+)$/i.exec(t);
  if (m) return { type: 'allow', reason: `Approved via Telegram: ${m[1].trim()}` };
  m = /^(?:no|n)\s*[:\-]\s*(.+)$/i.exec(t);
  if (m) return { type: 'deny', reason: `Denied via Telegram: ${m[1].trim()}` };

  return { type: null };
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

module.exports = {
  sendMessage,
  sendDocument,
  editMessageText,
  answerCallbackQuery,
  getUpdates,
  readStdin,
  loadState,
  saveState,
  loadCredentials,
  writeHeartbeat,
  isListenerAlive,
  buildApprovalKeyboard,
  parseReplyText,
  escapeHtml,
  redactSecret,
  loadJson,
  findProjectDir,
  projectNameFromCwd,
  appendAllowRule,
  PENDING_DIR,
  PID_FILE,
  HEARTBEAT_FILE,
  DATA_DIR,
};
