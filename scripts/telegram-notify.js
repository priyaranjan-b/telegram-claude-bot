#!/usr/bin/env node
'use strict';
const { sendMessage, readStdin, escapeHtml } = require('./telegram-lib');

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) process.exit(0);

  const raw = await readStdin();
  let message = 'Claude Code needs your attention';
  try {
    const input = JSON.parse(raw || '{}');
    if (input.message) message = input.message;
  } catch {
    // best-effort only
  }

  try {
    await sendMessage(token, chatId, `⏳ <b>Claude Code:</b> ${escapeHtml(message)}`);
  } catch (err) {
    console.error(String(err));
  }
  process.exit(0);
}

main();
