#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sendMessage,
  sendDocument,
  editMessageText,
  getUpdates,
  readStdin,
  loadState,
  saveState,
  loadCredentials,
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
  DATA_DIR,
} = require('./telegram-lib');

const MODE_FRESHNESS_SEC = 300; // ignore /local or /remote commands older than this
const MAX_WAIT_MS = 4 * 60 * 1000; // keep comfortably under the hook's own timeout
const POLL_SEC = 20;
const LOG_FILE = path.join(DATA_DIR, 'telegram-approve.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024; // rotate once the log passes 2MB
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Set once credentials are loaded in main(), so log() can redact the token from any
// error text logged afterward (it's embedded directly in every Telegram API request URL).
let currentToken = null;

function log(event, data) {
  const line = redactSecret(currentToken, JSON.stringify({ t: new Date().toISOString(), run: RUN_ID, pid: process.pid, event, ...data }));
  try {
    let size = 0;
    try {
      size = fs.statSync(LOG_FILE).size;
    } catch {
      // file doesn't exist yet
    }
    if (size > LOG_MAX_BYTES) {
      try {
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
      } catch {
        // best-effort rotation only
      }
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // logging must never break the hook
  }
}

function emit(decision, reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  log('emit', { output });
  console.log(JSON.stringify(output));
  process.exit(0);
}

// --- local permission-rule matching (mirrors the documented allow/deny/ask grammar) ---
// loadJson/findProjectDir now live in telegram-lib.js (telegram-listener.js needs them too,
// for the "always allow" button — see below).

// Best-effort plan lookup for ExitPlanMode: that tool takes no plan text as input (the
// plan lives in a file Claude writes just before calling it — confirmed empirically,
// this hook itself has watched that happen), so there's no stdin field to read it from.
// Heuristic: the newest .md file in the plans directory, as long as it was written very
// recently. This is NOT session-scoped — two plan-mode cycles racing on the same machine
// within the freshness window could pick up the wrong plan. Acceptable for this plugin's
// single-person/single-machine design (see README), but a real limitation worth knowing.
const PLAN_FRESHNESS_MS = 2 * 60 * 1000;

function resolvePlansDir(cwd) {
  const home = os.homedir();
  const globalSettings = loadJson(path.join(home, '.claude', 'settings.json'));
  const plansDirSetting = globalSettings && typeof globalSettings.plansDirectory === 'string' ? globalSettings.plansDirectory : null;
  if (plansDirSetting) {
    const projectDir = cwd ? findProjectDir(cwd) : process.cwd();
    return path.resolve(projectDir, plansDirSetting);
  }
  return path.join(home, '.claude', 'plans');
}

function readLatestPlan(cwd) {
  try {
    const dir = resolvePlansDir(cwd);
    const newest = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const p = path.join(dir, f);
        return { p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest || Date.now() - newest.mtime > PLAN_FRESHNESS_MS) return null;
    return fs.readFileSync(newest.p, 'utf8');
  } catch {
    return null;
  }
}

function loadPermissionLayers(cwd) {
  const home = os.homedir();
  const projectDir = cwd ? findProjectDir(cwd) : null;
  const files = [
    path.join(home, '.claude', 'settings.json'),
    ...(projectDir ? [path.join(projectDir, '.claude', 'settings.json'), path.join(projectDir, '.claude', 'settings.local.json')] : []),
  ];
  const allow = [];
  const deny = [];
  const ask = [];
  for (const file of files) {
    const parsed = loadJson(file);
    const p = parsed && parsed.permissions;
    if (!p) continue;
    if (Array.isArray(p.allow)) allow.push(...p.allow.map((r) => ({ rule: r, file })));
    if (Array.isArray(p.deny)) deny.push(...p.deny.map((r) => ({ rule: r, file })));
    if (Array.isArray(p.ask)) ask.push(...p.ask.map((r) => ({ rule: r, file })));
  }
  return { allow, deny, ask };
}

// "Tool" | "Tool(exact string)" | "Tool(prefix *)" | "Tool(prefix:*)" | "Tool(a*b)"
//
// Mirrors Claude Code's own rule syntax (see https://code.claude.com/docs/en/permissions.md):
// `*` matches any text (including spaces) and may appear anywhere in the pattern. A
// trailing `:*` is shorthand for a trailing ` *` — so `Bash(ls:*)` is identical to
// `Bash(ls *)`, and both match "ls" alone AND "ls -la" — recognized only when literally
// the last two characters; a colon anywhere else (e.g. `Bash(git:* push)`) is a plain
// literal character, not part of the wildcard.
function parseRule(rule) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/s.exec(rule);
  if (!m) return null;
  const [, tool, argRaw] = m;
  if (argRaw === undefined) return { tool, kind: 'tool-only' };

  const arg = argRaw.endsWith(':*') ? `${argRaw.slice(0, -2)} *` : argRaw;
  if (!arg.includes('*')) return { tool, kind: 'exact', value: arg };

  // A trailing "<prefix> *" also matches the bare prefix with nothing after it.
  const bareOk = arg.endsWith(' *');
  const trimmed = bareOk ? arg.slice(0, -2) : arg;
  const escaped = trimmed
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const regex = new RegExp(`^${escaped}${bareOk ? '(?: .*)?' : ''}$`, 's');
  return { tool, kind: 'pattern', regex };
}

function subjectFor(toolName, toolInput) {
  if (toolName === 'Bash') return (toolInput && toolInput.command) || '';
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    return (toolInput && toolInput.file_path) || '';
  }
  return '';
}

// For the remote "Always allow this" button: an exact-match rule for this specific
// command/file, not a prefix — deliberately conservative. null for tools with no
// natural single "subject" (never offered for ExitPlanMode regardless — see
// buildApprovalKeyboard).
function ruleForAlwaysAllow(toolName, toolInput) {
  const subject = subjectFor(toolName, toolInput);
  if (!subject) return null;
  return `${toolName}(${subject})`;
}

function ruleMatches(parsed, toolName, toolInput) {
  if (!parsed || parsed.tool !== toolName) return false;
  if (parsed.kind === 'tool-only') return true;
  const subject = subjectFor(toolName, toolInput);
  if (parsed.kind === 'exact') return subject === parsed.value;
  if (parsed.kind === 'pattern') return parsed.regex.test(subject);
  return false;
}

function findMatch(entries, toolName, toolInput) {
  for (const { rule, file } of entries) {
    const parsed = parseRule(rule);
    if (ruleMatches(parsed, toolName, toolInput)) return { rule, file };
  }
  return null;
}

// Never returns a decision on a deny/ask match — those always fall through to Telegram / normal flow.
function classifyLocally(toolName, toolInput, cwd) {
  const { allow, deny, ask } = loadPermissionLayers(cwd);
  const denyHit = findMatch(deny, toolName, toolInput);
  if (denyHit) return { decision: null, reason: 'deny rule matched', match: denyHit };
  const askHit = findMatch(ask, toolName, toolInput);
  if (askHit) return { decision: null, reason: 'ask rule matched', match: askHit };
  const allowHit = findMatch(allow, toolName, toolInput);
  if (allowHit) return { decision: 'allow', reason: 'allow rule matched', match: allowHit };
  return { decision: null, reason: 'no local rule matched' };
}

// --- message formatting ---

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Returns HTML-escaped, ready to drop straight into a <pre> block.
function formatToolSummary(toolName, toolInput, cwd) {
  const input = toolInput || {};
  const esc = escapeHtml;
  if (toolName === 'Bash') {
    const cmd = esc(input.command || '');
    return input.description ? `$ ${cmd}\n(${esc(input.description)})` : `$ ${cmd}`;
  }
  if (toolName === 'Edit') {
    return `${esc(input.file_path || '(unknown file)')}\n- ${esc(truncate(input.old_string, 200))}\n+ ${esc(truncate(input.new_string, 200))}`;
  }
  if (toolName === 'Write') {
    return `${esc(input.file_path || '(unknown file)')}\n${esc(truncate(input.content, 300))}`;
  }
  if (toolName === 'ExitPlanMode') {
    const plan = readLatestPlan(cwd);
    return esc(truncate(plan || '(could not locate the plan file — approve/deny blind, or check your terminal)', 3000));
  }
  return esc(truncate(JSON.stringify(input, null, 2), 500));
}

// Full, untruncated content for a Telegram file attachment — only when the inline
// preview above actually truncated something (returns null otherwise, so nothing extra
// gets sent for a short Edit/Write). Not a real line-based diff — no diffing library,
// stays dependency-free — just clearly labeled OLD/NEW (or full content for Write).
function fullContentForAttachment(toolName, toolInput) {
  const input = toolInput || {};
  if (toolName === 'Edit') {
    const oldStr = input.old_string || '';
    const newStr = input.new_string || '';
    if (oldStr.length <= 200 && newStr.length <= 200) return null;
    return {
      filename: `${sanitizeFilename(input.file_path)}.diff.txt`,
      content: `FILE: ${input.file_path || '(unknown file)'}\n\n--- OLD ---\n${oldStr}\n\n--- NEW ---\n${newStr}`,
      caption: '📄 Full content (truncated above)',
    };
  }
  if (toolName === 'Write') {
    const content = input.content || '';
    if (content.length <= 300) return null;
    return {
      filename: `${sanitizeFilename(input.file_path)}.txt`,
      content: `FILE: ${input.file_path || '(unknown file)'}\n\n${content}`,
      caption: '📄 Full content (truncated above)',
    };
  }
  return null;
}

function sanitizeFilename(filePath) {
  const base = filePath ? path.basename(filePath) : 'file';
  return base.replace(/[^\w.-]/g, '_');
}

// --- remote-mode waiting strategies ---

// `detail` must already be HTML-escaped (formatToolSummary does this) — it goes
// straight into a <pre> block, visually separated from the "what's being asked" header.
function promptText(toolName, detail, project) {
  const tag = project ? `<b>[${escapeHtml(project)}]</b> ` : '';
  if (toolName === 'ExitPlanMode') {
    return (
      `📋 ${tag}<b>Claude Code has a plan ready for approval:</b>\n` +
      `<pre>${detail}</pre>\n` +
      `<i>Tap YES to approve, NO to reject, or just reply with feedback/questions — Claude will see it and revise the plan. Auto-falls back to the normal prompt in 4 min.</i>`
    );
  }
  return (
    `🔧 ${tag}<b>Claude Code wants to run:</b> <b>${escapeHtml(toolName)}</b>\n` +
    `<pre>${detail}</pre>\n` +
    `<i>Tap a button below, reply with feedback, or type YES/NO (optionally "NO: reason"). Auto-falls back to the normal prompt in 4 min.</i>`
  );
}

// Listener is running: it owns all Telegram polling. We just drop a request file and
// wait for it to drop the matching result file, so there's only ever one poller.
async function waitViaListener(ctx) {
  const { token, chatId, toolName, toolInput, detail, cwd, project, attachment } = ctx;
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const requestFile = path.join(PENDING_DIR, `${requestId}.request.json`);
  const resultFile = path.join(PENDING_DIR, `${requestId}.result.json`);
  const cleanup = () => {
    try {
      fs.unlinkSync(requestFile);
    } catch {
      // already gone
    }
    try {
      fs.unlinkSync(resultFile);
    } catch {
      // already gone
    }
  };

  // subject/cwd/project let telegram-listener.js (a separate process) build an
  // "always allow" rule later, when the button is tapped, without needing the full
  // toolInput (which for Edit/Write could be a large diff — no reason to duplicate that
  // into the request file).
  fs.writeFileSync(
    requestFile,
    JSON.stringify({ toolName, subject: subjectFor(toolName, toolInput), cwd, project, createdAt: Date.now() })
  );
  let messageId = null;
  try {
    const sent = await sendMessage(token, chatId, promptText(toolName, detail, project), buildApprovalKeyboard(requestId, toolName));
    messageId = sent && sent.message_id;
    if (attachment) {
      await sendDocument(token, chatId, attachment.filename, attachment.content, attachment.caption).catch((err) =>
        log('attachment_error', { message: err.message })
      );
    }
    log('prompt_sent', { toolName, requestId, via: 'listener' });
  } catch (err) {
    log('send_error', { message: err.message });
    cleanup();
    return emit('ask', `Could not reach Telegram: ${err.message}`);
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) {
      let result = null;
      try {
        result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      } catch (err) {
        log('result_parse_error', { message: err.message });
      }
      cleanup();
      if (result && result.decision) {
        log('result_received', result);
        return emit(result.decision, result.reason);
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  cleanup();
  log('timeout', { requestId, via: 'listener' });
  if (messageId) {
    await editMessageText(
      token,
      chatId,
      messageId,
      `${promptText(toolName, detail, project)}\n\n<b>⏰ Timed out — showing local prompt</b>`
    ).catch(() => {});
  }
  return emit('ask', 'No response within 4 minutes, falling back to normal prompt');
}

// No listener running: poll Telegram directly ourselves, same as before the listener existed.
async function waitDirectly(ctx) {
  const { token, chatId, toolName, toolInput, detail, cwd, project, attachment, state } = ctx;
  const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let messageId = null;
  try {
    const sent = await sendMessage(token, chatId, promptText(toolName, detail, project), buildApprovalKeyboard(requestId, toolName));
    messageId = sent && sent.message_id;
    if (attachment) {
      await sendDocument(token, chatId, attachment.filename, attachment.content, attachment.caption).catch((err) =>
        log('attachment_error', { message: err.message })
      );
    }
    log('prompt_sent', { toolName, requestId, via: 'direct' });
  } catch (err) {
    log('send_error', { message: err.message });
    return emit('ask', `Could not reach Telegram: ${err.message}`);
  }

  const resolve = async (decision, reason, label) => {
    if (messageId) {
      await editMessageText(token, chatId, messageId, `${promptText(toolName, detail, project)}\n\n<b>${escapeHtml(label)}</b>`).catch(() => {});
    }
    return emit(decision, reason);
  };

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const remainingSec = Math.max(5, Math.min(POLL_SEC, Math.floor((deadline - Date.now()) / 1000)));
    let updates;
    try {
      updates = await getUpdates(token, state.offset, remainingSec);
      log('poll', { offset: state.offset, remainingSec, count: updates.length });
    } catch (err) {
      log('poll_error', { message: err.message });
      continue; // transient network hiccup — keep polling until the deadline
    }
    for (const update of updates) {
      state.offset = update.update_id + 1;
      saveState(state);

      if (update.callback_query) {
        const cq = update.callback_query;
        const okChat = cq.message && String(cq.message.chat.id) === String(chatId);
        const [action, id] = String(cq.data || '').split('|');
        log('callback_seen', { action, id, okChat });
        if (!okChat || id !== requestId) continue; // not ours (stale button or a different request)
        if (action === 'local') {
          state.mode = 'local';
          saveState(state);
          log('mode_switch', { to: 'local', via: 'telegram-callback' });
          return resolve('ask', 'Switched to local mode via Telegram', 'Switched to local mode');
        }
        if (action === 'alwaysallow') {
          const rule = ruleForAlwaysAllow(toolName, toolInput);
          if (rule) {
            try {
              appendAllowRule(rule, cwd);
            } catch (err) {
              log('always_allow_error', { message: err.message });
            }
          }
          log('mode_switch', { alwaysAllowRule: rule });
          return resolve(
            'allow',
            rule ? `Approved via Telegram (always-allow rule added: ${rule})` : 'Approved via Telegram',
            rule ? '✅ Approved — always-allow rule added' : 'Approved ✅'
          );
        }
        const decision = action === 'allow' ? 'allow' : 'deny';
        return resolve(decision, decision === 'allow' ? 'Approved via Telegram' : 'Denied via Telegram', decision === 'allow' ? 'Approved ✅' : 'Denied ❌');
      }

      const msg = update.message;
      if (!msg || String(msg.chat.id) !== String(chatId)) continue;
      log('update_seen', { updateId: update.update_id, text: msg.text });
      const parsed = parseReplyText(msg.text);
      if (parsed.type === 'local') {
        state.mode = 'local';
        saveState(state);
        log('mode_switch', { to: 'local', via: 'telegram' });
        return resolve('ask', 'Switched to local mode via Telegram — showing normal prompt', 'Switched to local mode');
      }
      if (parsed.type === 'allow') return resolve('allow', parsed.reason, 'Approved ✅');
      if (parsed.type === 'deny') return resolve('deny', parsed.reason, 'Denied ❌');
      // Any other free-text reply on a pending request is feedback: deny with that text as
      // the reason, so Claude sees it on its next turn and can revise/retry accordingly.
      if (parsed.type === null && msg.text && msg.text.trim()) {
        const prefix = toolName === 'ExitPlanMode' ? 'Plan feedback via Telegram' : 'Feedback via Telegram';
        return resolve('deny', `${prefix}: ${msg.text.trim()}`, '💬 Feedback sent to Claude');
      }
    }
  }
  log('timeout', { via: 'direct' });
  if (messageId) {
    await editMessageText(
      token,
      chatId,
      messageId,
      `${promptText(toolName, detail, project)}\n\n<b>⏰ Timed out — showing local prompt</b>`
    ).catch(() => {});
  }
  return emit('ask', 'No Telegram reply within 4 minutes, falling back to normal prompt');
}

// --- main ---

async function main() {
  log('start', { argv: process.argv, cwd: process.cwd() });
  const raw = await readStdin();
  log('stdin', { raw: raw.slice(0, 2000) });

  let toolName = 'a tool';
  let toolInput = {};
  let cwd = '';
  let permissionMode = '';
  try {
    const input = JSON.parse(raw || '{}');
    toolName = input.tool_name || toolName;
    toolInput = input.tool_input || {};
    cwd = input.cwd || '';
    permissionMode = input.permission_mode || '';
  } catch (err) {
    log('stdin_parse_error', { message: err.message });
  }

  if (permissionMode === 'bypassPermissions') {
    return emit('allow', 'Session is in bypassPermissions mode');
  }

  const local = classifyLocally(toolName, toolInput, cwd);
  log('local_check', local);
  if (local.decision === 'allow') {
    return emit('allow', `Matched local allow rule: ${local.match.rule} (${local.match.file})`);
  }

  const { token, chatId } = loadCredentials();
  currentToken = token;
  if (!token || !chatId) return emit('ask', 'Telegram not configured, falling back to normal prompt');

  const detail = formatToolSummary(toolName, toolInput, cwd);
  const project = projectNameFromCwd(cwd);
  const attachment = fullContentForAttachment(toolName, toolInput);

  let state = loadState();
  log('state_loaded', state);

  const listenerAlive = isListenerAlive();
  log('listener_check', { alive: listenerAlive });

  // When no listener is watching, do our own quick, non-blocking check for a /local or
  // /remote command sent since we last looked (the listener handles this instantly itself).
  if (!listenerAlive) {
    try {
      const pending = await getUpdates(token, state.offset, 0);
      for (const update of pending) {
        state.offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || String(msg.chat.id) !== String(chatId)) continue;
        const fresh = Date.now() / 1000 - (msg.date || 0) < MODE_FRESHNESS_SEC;
        const parsed = parseReplyText(msg.text);
        if (fresh && (parsed.type === 'remote' || parsed.type === 'local')) {
          state.mode = parsed.type;
          log('mode_switch', { to: state.mode, via: 'telegram' });
        }
      }
      saveState(state);
    } catch (err) {
      log('mode_check_error', { message: err.message });
    }
  }

  if (state.mode === 'local') {
    return emit('ask', 'Local approval mode active — showing normal prompt (reply /remote on Telegram to switch back)');
  }

  const ctx = { token, chatId, toolName, toolInput, detail, cwd, project, attachment, state };
  if (listenerAlive) {
    return waitViaListener(ctx);
  }
  return waitDirectly(ctx);
}

main();
