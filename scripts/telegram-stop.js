#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { sendMessage, readStdin, escapeHtml, projectNameFromCwd } = require('./telegram-lib');

function truncateList(items, max) {
  const arr = Array.from(items);
  if (arr.length <= max) return arr.join(', ');
  return `${arr.slice(0, max).join(', ')} (+${arr.length - max} more)`;
}

// Best-effort digest of what actually happened this session, scanned from the
// transcript Claude Code already writes — no LLM call, so it costs nothing extra
// and can't hang the Stop hook waiting on a model.
function summarizeTranscript(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);

  let title = null;
  const filesTouched = new Set();
  let bashCount = 0;
  let toolUseCount = 0;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'custom-title' && entry.customTitle) title = entry.customTitle;
    else if (entry.type === 'ai-title' && entry.aiTitle && !title) title = entry.aiTitle;

    if (entry.type !== 'assistant' || !entry.message || !Array.isArray(entry.message.content)) continue;
    for (const item of entry.message.content) {
      if (!item || item.type !== 'tool_use') continue;
      toolUseCount++;
      if (item.name === 'Bash') bashCount++;
      if ((item.name === 'Edit' || item.name === 'Write' || item.name === 'NotebookEdit') && item.input && item.input.file_path) {
        filesTouched.add(String(item.input.file_path).split(/[\\/]/).pop());
      }
    }
  }

  const stats = [];
  if (filesTouched.size) stats.push(`${filesTouched.size} file${filesTouched.size === 1 ? '' : 's'} touched`);
  if (bashCount) stats.push(`${bashCount} command${bashCount === 1 ? '' : 's'} run`);
  if (toolUseCount) stats.push(`${toolUseCount} tool call${toolUseCount === 1 ? '' : 's'} total`);

  const lines2 = [];
  if (title) lines2.push(`<b>${escapeHtml(title)}</b>`);
  if (stats.length) lines2.push(`📊 ${escapeHtml(stats.join(', '))}`);
  if (filesTouched.size) lines2.push(`<pre>${escapeHtml(truncateList(filesTouched, 8))}</pre>`);
  return lines2.join('\n');
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) process.exit(0);

  const raw = await readStdin();
  let project = '';
  let summary = '';
  try {
    const input = JSON.parse(raw || '{}');
    const cwd = input.cwd || '';
    project = projectNameFromCwd(cwd);
    if (input.transcript_path) {
      try {
        summary = summarizeTranscript(input.transcript_path);
      } catch {
        // transcript parsing is best-effort only — never block the notification on it
      }
    }
  } catch {
    // best-effort only
  }

  const header = `✅ <b>Session stopped</b>${project ? ` — <i>${escapeHtml(project)}</i>` : ''}`;
  const text = [header, summary].filter(Boolean).join('\n\n');
  try {
    await sendMessage(token, chatId, text);
  } catch (err) {
    console.error(String(err));
  }
  process.exit(0);
}

main();
