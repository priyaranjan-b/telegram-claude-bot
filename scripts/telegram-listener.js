#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  getUpdates,
  loadState,
  saveState,
  loadCredentials,
  writeHeartbeat,
  parseReplyText,
  escapeHtml,
  redactSecret,
  appendAllowRule,
  PENDING_DIR,
} = require('./telegram-lib');

const POLL_SEC = 25;
const STALE_REQUEST_MS = 5 * 60 * 1000; // matches telegram-approve.js's own MAX_WAIT_MS

// Set once credentials are loaded in main(), so log() can redact the token from any
// error text logged afterward (it's embedded directly in every Telegram API request URL).
let currentToken = null;

function log(...args) {
  const safeArgs = args.map((a) => (typeof a === 'string' ? redactSecret(currentToken, a) : a));
  console.log(new Date().toISOString(), ...safeArgs);
}

// Returns still-open requests, oldest first, and garbage-collects anything past its
// own wait window so a much later stray reply can never be misapplied to it.
function listPending() {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const now = Date.now();
  const entries = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith('.request.json'));
  const result = [];
  for (const f of entries) {
    const id = f.replace(/\.request\.json$/, '');
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8'));
    } catch {
      // malformed — treat as stale below
    }
    if (!data.createdAt || now - data.createdAt > STALE_REQUEST_MS) {
      try {
        fs.unlinkSync(path.join(PENDING_DIR, f));
      } catch {
        // already gone
      }
      try {
        fs.unlinkSync(path.join(PENDING_DIR, `${id}.result.json`));
      } catch {
        // already gone
      }
      continue;
    }
    result.push({ id, ...data });
  }
  return result.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function findPending(id) {
  return listPending().find((p) => p.id === id) || null;
}

function writeResult(id, decision, reason) {
  fs.writeFileSync(
    path.join(PENDING_DIR, `${id}.result.json`),
    JSON.stringify({ decision, reason, resolvedAt: Date.now() })
  );
}

async function handleCallbackQuery(token, chatId, cq) {
  const okChat = cq.message && String(cq.message.chat.id) === String(chatId);
  const [action, requestId] = String(cq.data || '').split('|');
  if (!okChat || !requestId) {
    await answerCallbackQuery(token, cq.id, '').catch(() => {});
    return;
  }

  const pending = findPending(requestId);
  if (!pending) {
    await answerCallbackQuery(token, cq.id, 'Already handled or expired').catch(() => {});
    return;
  }

  // cq.message.text is Telegram's own rendered plain text (formatting entities stripped),
  // so it must be re-escaped before going back through parse_mode HTML.
  const editSuffix = (label) =>
    editMessageText(
      token,
      chatId,
      cq.message.message_id,
      `${escapeHtml(cq.message.text)}\n\n<b>${escapeHtml(label)}</b>`
    ).catch(() => {});

  if (action === 'local') {
    const state = loadState();
    state.mode = 'local';
    saveState(state);
    writeResult(requestId, 'ask', 'Switched to local mode via Telegram');
    await answerCallbackQuery(token, cq.id, 'Switched to local mode').catch(() => {});
    await editSuffix('🔀 Switched to local mode');
    log('mode_switch', 'local', 'via callback');
    return;
  }

  if (action === 'alwaysallow') {
    // pending.subject is only set for tool types the "always allow" button is offered for
    // (see buildApprovalKeyboard) — never ExitPlanMode. Missing subject (e.g. a stale
    // pre-upgrade request file) just skips the rule and still approves this once.
    const rule = pending.subject ? `${pending.toolName}(${pending.subject})` : null;
    if (rule) {
      try {
        appendAllowRule(rule, pending.cwd);
      } catch (err) {
        log('always_allow_error:', err.message);
      }
    }
    writeResult(requestId, 'allow', rule ? `Approved via Telegram (always-allow rule added: ${rule})` : 'Approved via Telegram');
    await answerCallbackQuery(token, cq.id, rule ? 'Approved + rule added' : 'Approved').catch(() => {});
    await editSuffix(rule ? '✅ Approved — always-allow rule added' : '✅ Approved');
    log('resolved', { id: requestId, decision: 'allow', alwaysAllowRule: rule, via: 'callback' });
    return;
  }

  const decision = action === 'allow' ? 'allow' : 'deny';
  writeResult(requestId, decision, decision === 'allow' ? 'Approved via Telegram' : 'Denied via Telegram');
  await answerCallbackQuery(token, cq.id, decision === 'allow' ? 'Approved' : 'Denied').catch(() => {});
  await editSuffix(decision === 'allow' ? '✅ Approved' : '❌ Denied');
  log('resolved', { id: requestId, decision, via: 'callback' });
}

async function handleMessage(token, chatId, msg) {
  const parsed = parseReplyText(msg.text);

  if (parsed.type === 'status') {
    const state = loadState();
    const pending = listPending();
    const modeEmoji = state.mode === 'remote' ? '📡' : '💻';
    let pendingLine = '';
    if (pending.length) {
      const breakdown = pending.map((p) => `${p.project ? `${escapeHtml(p.project)} ` : ''}(${escapeHtml(p.toolName)})`).join(', ');
      pendingLine = `\n⏳ <i>${pending.length} pending request${pending.length === 1 ? '' : 's'}: ${breakdown}</i>`;
    }
    await sendMessage(token, chatId, `${modeEmoji} <b>Approval mode:</b> ${escapeHtml(state.mode)}` + pendingLine);
    return;
  }

  if (parsed.type === 'local' || parsed.type === 'remote') {
    const state = loadState();
    state.mode = parsed.type;
    saveState(state);
    const modeEmoji = state.mode === 'remote' ? '📡' : '💻';
    await sendMessage(token, chatId, `${modeEmoji} <b>Approval mode:</b> ${escapeHtml(state.mode)}`, {
      remove_keyboard: true,
    });
    log('mode_switch', state.mode, 'via text');
    return;
  }

  if (parsed.type !== 'allow' && parsed.type !== 'deny') {
    // Any other free-text reply on a pending request is feedback: deny with that text as
    // the reason, so Claude sees it on its next turn and can revise/retry accordingly
    // (there's no real two-way chat with a single hook decision — this is the closest
    // equivalent, and the best Claude Code's hook system supports).
    const pending = listPending();
    const target = pending[0];
    if (target && msg.text && msg.text.trim()) {
      const prefix = target.toolName === 'ExitPlanMode' ? 'Plan feedback via Telegram' : 'Feedback via Telegram';
      writeResult(target.id, 'deny', `${prefix}: ${msg.text.trim()}`);
      await sendMessage(token, chatId, '💬 <b>Feedback sent to Claude.</b>', { remove_keyboard: true });
      log('resolved', { id: target.id, decision: 'deny', via: 'text-discuss' });
    }
    return; // otherwise ignore
  }

  const pending = listPending();
  if (!pending.length) return; // nothing waiting — nothing to apply this reply to
  const target = pending[0]; // oldest open request (typed replies can't name a specific one — use a button to be precise)
  writeResult(target.id, parsed.type, parsed.reason);
  await sendMessage(token, chatId, parsed.type === 'allow' ? '✅ <b>Approved.</b>' : '❌ <b>Denied.</b>', {
    remove_keyboard: true,
  });
  log('resolved', { id: target.id, decision: parsed.type, via: 'text' });
}

async function main() {
  const { token, chatId } = loadCredentials();
  currentToken = token;
  if (!token || !chatId) {
    console.error('No Telegram credentials found (checked env vars and ~/.claude/settings.json env block).');
    process.exit(1);
  }

  fs.mkdirSync(PENDING_DIR, { recursive: true });
  writeHeartbeat();

  log(`Telegram listener started. Mode: ${loadState().mode}. Press Ctrl+C to stop.`);

  process.on('SIGINT', () => {
    log('Listener stopped.');
    process.exit(0);
  });

  // Last-resort safety net: never let an unexpected error kill the listener silently.
  process.on('uncaughtException', (err) => log('uncaughtException:', err && err.stack ? err.stack : String(err)));
  process.on('unhandledRejection', (err) => log('unhandledRejection:', err && err.stack ? err.stack : String(err)));

  let state = loadState();
  for (;;) {
    // Written every iteration, right before the network call — deliberately NOT on an
    // independent timer (that was the bug: a stuck/hung getUpdates call, e.g. after a
    // Telegram-side "Conflict" from a second poller, left the loop dead forever while an
    // unrelated setInterval kept writing a healthy heartbeat, so isListenerAlive() reported
    // "running" indefinitely and nothing ever fell back to direct polling). See CLAUDE.md.
    writeHeartbeat();
    let updates;
    try {
      updates = await getUpdates(token, state.offset, POLL_SEC);
    } catch (err) {
      log('poll error:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    for (const update of updates) {
      state.offset = update.update_id + 1;
      try {
        saveState(state);
        if (update.callback_query) {
          await handleCallbackQuery(token, chatId, update.callback_query);
        } else if (update.message && String(update.message.chat.id) === String(chatId)) {
          await handleMessage(token, chatId, update.message);
        }
      } catch (err) {
        log('handle error:', err.message);
      }
    }
  }
}

main();
