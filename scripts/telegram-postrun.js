#!/usr/bin/env node
'use strict';
const { sendMessage, readStdin, escapeHtml, loadCredentials, loadState, projectNameFromCwd } = require('./telegram-lib');

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function formatDuration(ms) {
  if (typeof ms !== 'number') return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const { token, chatId } = loadCredentials();
  if (!token || !chatId) process.exit(0);

  // Only fires in remote mode. Mirrors telegram-approve.js's philosophy that Telegram
  // traffic is for when you're away from the terminal — Stop/Notification are unconditional
  // simple pings, but this hook fires on *every* Bash call, so pinging in local mode too
  // would spam Telegram for a session you're already watching in the terminal.
  if (loadState().mode !== 'remote') process.exit(0);

  const raw = await readStdin();
  let toolInput = {};
  let cwd = '';
  let durationMs = null;
  let ok = true;
  let detail = '';
  try {
    const input = JSON.parse(raw || '{}');
    toolInput = input.tool_input || {};
    cwd = input.cwd || '';
    durationMs = input.duration_ms;
    // Confirmed empirically (this repo has no docs for the exact PostToolUse/
    // PostToolUseFailure payload shape for Bash — see CLAUDE.md): a non-zero exit fires
    // PostToolUseFailure with a combined `error` string (exit-code line + stderr), not
    // PostToolUse with a tool_response. `hook_event_name` is the primary signal; the
    // `error` presence check is just a cheap fallback if that field is ever missing.
    if (input.hook_event_name === 'PostToolUseFailure' || input.error) {
      ok = false;
      detail = truncate(input.error || '(no error detail)', 500);
    } else {
      const resp = input.tool_response || {};
      detail = truncate([resp.stdout, resp.stderr].filter(Boolean).join('\n'), 500) || '(no output)';
    }
  } catch {
    process.exit(0); // can't make sense of this — say nothing rather than guess
  }

  const project = projectNameFromCwd(cwd);
  const tag = project ? `[${escapeHtml(project)}] ` : '';
  const duration = formatDuration(durationMs);
  const cmd = escapeHtml(truncate(toolInput.command || '', 200));
  const header = `${ok ? '✅' : '❌'} ${tag}<b>Command ${ok ? 'finished' : 'failed'}</b>${duration ? ` <i>(${duration})</i>` : ''}`;
  const text = `${header}\n<pre>$ ${cmd}</pre>\n<pre>${escapeHtml(detail)}</pre>`;

  try {
    await sendMessage(token, chatId, text);
  } catch (err) {
    console.error(String(err));
  }
  process.exit(0);
}

main();
