#!/usr/bin/env node
'use strict';
const { sendMessage, readStdin, escapeHtml, loadCredentials, projectNameFromCwd } = require('./telegram-lib');

// Documented values (code.claude.com/docs/en/hooks): startup|resume|clear|compact|fork.
// Only announce genuine new sessions — resume/clear/compact/fork aren't "work has begun",
// they're continuations of something already known about. If this field is ever missing
// or an unrecognized value, default to announcing anyway (fail toward a notification, not
// silently doing nothing and looking broken).
const SKIP_TYPES = new Set(['resume', 'clear', 'compact', 'fork']);

async function main() {
  const { token, chatId } = loadCredentials();
  if (!token || !chatId) process.exit(0);

  const raw = await readStdin();
  let cwd = '';
  let startType = '';
  try {
    const input = JSON.parse(raw || '{}');
    cwd = input.cwd || '';
    startType = input.session_start_type || '';
  } catch {
    // best-effort only
  }

  if (SKIP_TYPES.has(startType)) process.exit(0);

  const project = projectNameFromCwd(cwd);
  const text = `🚀 <b>Session started</b>${project ? ` — <i>${escapeHtml(project)}</i>` : ''}`;

  try {
    await sendMessage(token, chatId, text);
  } catch (err) {
    console.error(String(err));
  }
  process.exit(0);
}

main();
