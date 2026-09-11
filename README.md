# telegram-claude-bot

Telegram-based notification and remote-approval bridge for Claude Code hooks.

- Get a Telegram ping when a Claude Code session finishes (with a short digest
  of what happened) or needs your attention.
- Optionally route permission prompts (Bash/Edit/Write/NotebookEdit) to
  Telegram with tappable YES/NO buttons, so you can approve or deny actions
  from your phone.
- A `local`/`remote` mode toggle keeps normal in-terminal prompts most of the
  time, and switches to Telegram-routed approval only when you're away from
  the computer.
- Anything already covered by your existing Claude Code `permissions.allow`
  rules is approved instantly, with zero Telegram contact.

This README is written so a colleague can set this up on their own machine
from scratch, including creating their own Telegram bot.

---

## Security & privacy — read this first

- **Approval prompts show real content.** When remote mode asks you to
  approve a Bash command, an Edit, or a Write, the actual command / diff /
  file-content preview is sent to your Telegram chat, and a full trace of
  every decision (including that same content) is written to a local,
  plaintext `telegram-approve.log`. Don't rely on remote mode for sessions
  touching secrets you wouldn't want sitting in your Telegram history or in a
  log file on disk.
- **The bot token is a secret.** Anyone who has it can send messages as your
  bot and read everything it receives — treat it like a password (secure
  storage if you install via the plugin path below, never a committed file).
- **One bot, one chat, one person.** This is designed for a single person on
  a single machine. Don't share a bot token or chat ID between colleagues or
  machines.
- **The local permission matcher is best-effort.** The `PreToolUse` hook
  reimplements Claude Code's own `permissions.allow`/`deny`/`ask` rule syntax
  locally (so it can skip Telegram for stuff you've already allowed) — see
  [How it works](#how-it-works). It's tested against the documented syntax,
  but it's not Claude Code's actual matching engine. A mismatch always fails
  *safe*: worst case is one extra prompt, never a silent auto-approval of
  something your real settings would have blocked.

## 1. Create your own Telegram bot

Each person needs their **own** bot and chat ID — do not share a token between
machines or people; whoever holds a bot's token can fully control it.

1. Open Telegram and search for **BotFather** (the official bot-creation bot —
   it has a blue verified checkmark, username `@BotFather`).
2. Start a chat with it and send:
   ```
   /newbot
   ```
3. BotFather asks for a **display name** — anything you like, e.g. `My Claude Code Bot`.
4. Then it asks for a **username** — must be unique and end in `bot`, e.g.
   `yourname_claude_bot`.
5. BotFather replies with a message containing your **API token**, a string
   that looks like:
   ```
   123456789:AAExampleTokenDoNotShareThisWithAnyone
   ```
   Copy and keep it somewhere safe (a password manager, not a chat log or a
   committed file). Anyone with this token can send messages as your bot and
   read its incoming messages.

(Optional) You can set a profile picture or description for the bot with
`/setuserpic` or `/setdescription` in BotFather — purely cosmetic, skip if you
don't care.

## 2. Find your chat ID

The bot needs to know *your* chat ID so it only ever talks to you.

1. Open your new bot in Telegram (search its username, or open the `t.me/...`
   link BotFather gave you) and send it any message, e.g. `hi`.
2. In a browser, open this URL, replacing `<TOKEN>` with your bot's token:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. You'll see a JSON response containing something like:
   ```json
   "chat": { "id": 123456789, "first_name": "Your Name", "type": "private" }
   ```
   That number (`123456789` in this example) is your **chat ID**.

If the response is empty (`"result":[]`), you likely sent the message before
opening the URL for the first time, or Telegram hasn't delivered it yet — send
another message to the bot and refresh the URL.

## 3. Choose how to install

There are two ways to set this up. **Pick one — don't do both**, since
running the same hooks twice (once from each install) would double up
Telegram messages and fight over the same mode/state.

| | Full setup (recommended) | Lightweight plugin install |
|---|---|---|
| Stop / Notification pings | ✅ | ✅ |
| Silent pass-through for already-allowed actions | ✅ | ✅ |
| Remote-approval mode (YES/NO buttons) | ✅ | Partial — see caveat below |
| `tg-code` shell shortcut (mode switch, listener control) | ✅ | ❌ not available |
| Secrets stored | Plaintext in your global `settings.json` | Securely, by Claude Code |
| Setup effort | A few manual edits | Two slash commands |

The **plugin install** is genuinely lighter-weight, but `tg-code` and the
background listener are separate standalone processes that Claude Code
doesn't hand plugin secrets or paths to — only actual hook invocations get
those (see [Known limitations](#known-limitations)). So today, the plugin
install alone doesn't give you the shell shortcut or a persistent listener.
If you want the full feature set, use the **Full setup**.

---

## 3a. Full setup (recommended)

Requires [Node.js](https://nodejs.org) (18+; anything with built-in `fetch`
works) on your machine — no npm packages needed, everything here is
dependency-free.

**Copy the scripts.** Clone this repo, or copy just the `scripts/` folder,
to a stable location on your machine — somewhere you won't move or delete.
The examples below use:

- **Windows**: `%USERPROFILE%\.claude\hooks\`
- **macOS/Linux**: `~/.claude/hooks/`

You only need the contents of `scripts/` (not `hooks/`, which is the plugin
manifest used only by the lightweight install below):

```
scripts/
├── telegram-lib.js          shared helpers (Telegram API calls, state, mode)
├── telegram-stop.js         Stop hook — one-way "session finished" digest
├── telegram-notify.js       Notification hook — one-way "needs attention" ping
├── telegram-sessionstart.js SessionStart hook — one-way "session started" ping
├── telegram-approve.js      PreToolUse hook — the approval bridge itself
├── telegram-postrun.js      PostToolUse/PostToolUseFailure hook — reports
│                             whether an approved Bash command succeeded (remote mode only)
├── telegram-listener.js     optional always-on background listener
└── set-mode.js              mode/listener control, used by the tg-code shortcut
```

**Configure `~/.claude/settings.json`.** This is your **global** Claude Code
user settings file (not a project's `.claude/settings.json`) — it applies
across every project on your machine.

Open (or create) `~/.claude/settings.json` and merge in the contents of this
repo's `settings.example.json`, filling in:

- `TELEGRAM_BOT_TOKEN` — your token from step 1
- `TELEGRAM_CHAT_ID` — your chat ID from step 2
- The hook `command` paths — point them at wherever you put the scripts,
  e.g. on Windows:
  `node "C:/Users/<you>/.claude/hooks/telegram-approve.js"`,
  or on macOS/Linux: `node "/Users/<you>/.claude/hooks/telegram-approve.js"`.

**Merge, don't overwrite** — if you already have a `settings.json` with other
settings (permissions, model, etc.), add the `env` and `hooks` keys alongside
what's already there. If a `hooks` key already exists, merge the `Stop`,
`Notification`, and `PreToolUse` entries into it rather than replacing it.

**Never commit your filled-in `settings.json`** to any repo — it will contain
your live bot token in plaintext.

**Install the `tg-code` shell shortcut.** Pick the one matching your shell
(both can be installed if you use both).

**PowerShell** (Windows): append the contents of `shell/profile-snippet.ps1`
to your profile. Find its path with:
```powershell
echo $PROFILE
```
If the file doesn't exist yet, create it first (`New-Item -ItemType File -Path $PROFILE -Force`), then open it in an editor and paste the snippet in.

**Bash** (Git Bash on Windows, or macOS/Linux): append the contents of
`shell/bashrc-snippet.sh` to `~/.bashrc`. On Git Bash specifically, also make
sure `~/.bash_profile` sources it (Git Bash starts as a login shell by default
and won't read `.bashrc` otherwise):
```bash
echo 'if [ -f ~/.bashrc ]; then source ~/.bashrc; fi' >> ~/.bash_profile
```

Reload your shell (open a new terminal, or `. $PROFILE` / `source ~/.bashrc`),
then confirm it worked:
```
tg-code help
```

**Verify it works.**
```
tg-code mode remote
```
This switches to remote mode and starts the background listener. Then, from
a real terminal (not an IDE extension — see Known limitations), ask Claude
Code to do something that isn't already on your permission allow-list (e.g.
edit a file you haven't touched before). You should get a Telegram message
with YES/NO buttons within a few seconds.
```
tg-code mode local
```
Switches back to normal local-only prompts (and stops the listener).

## 3b. Lightweight plugin install (optional, hooks-only)

Gives you Stop/Notification pings and silent pass-through for already-allowed
actions, with secrets entered once and stored securely by Claude Code — no
shell profile edits, no plaintext `settings.json` token.

In a Claude Code session:
```
/plugin marketplace add priyaranjan-b/telegram-claude-bot
/plugin install telegram-claude-bot@cc-plugins
```
(Testing a local clone instead? `/plugin marketplace add /path/to/telegram-claude-bot` works the same way.)
You'll be prompted for your bot token and chat ID at install time (masked
input, stored in secure storage rather than a settings file).

**What you get:** Stop/Notification pings, and the `PreToolUse` hook silently
approving anything your existing `permissions.allow` rules already cover.

**What you don't get:** `tg-code` and the background listener aren't part of
the plugin — those are standalone scripts Claude Code doesn't hand plugin
secrets or install paths to. Remote-approval mode *can* still be triggered by
texting `/remote` straight to your bot (the hook checks for that on every
tool call), but without the listener you lose instant `/status` replies, and
concurrent tool calls each poll Telegram independently — since Telegram's
update offset is global per bot token, that risks one request seeing (and
consuming) the reply meant for another. Use the **Full setup** above if you
actually want to use remote mode.

To update: `/plugin marketplace update cc-plugins` refreshes the catalog;
to remove: `/plugin uninstall telegram-claude-bot@cc-plugins` and
`/plugin marketplace remove cc-plugins`.

---

## Commands

`tg-code` is only available with the Full setup (3a).

| Command | Does |
|---|---|
| `tg-code mode` / `tg-code mode status` | Show current approval mode |
| `tg-code mode local` | Switch to local mode (also stops the listener) |
| `tg-code mode remote` | Switch to remote mode (also starts the listener) |
| `tg-code listen` | Run the listener in the foreground (Ctrl+C to stop) |
| `tg-code listen start` | Start the listener detached in the background |
| `tg-code listen stop` | Stop the background listener |
| `tg-code listen --status` | Check whether the listener is actually running |
| `tg-code help` | Show this list |

From Telegram itself, you can also send `/status`, `/local`, or `/remote` to
the bot directly — picked up instantly if the listener is running, or applied
on the next pending prompt otherwise.

## How it works

- **`telegram-stop.js`** / **`telegram-notify.js`** — simple one-way pings,
  fired on the `Stop` and `Notification` hook events respectively. The Stop
  ping includes a short digest (files touched, commands run, tool-call count)
  parsed from the session transcript — no LLM call involved, so it's free and
  can't hang the hook.
- **`telegram-approve.js`** (`PreToolUse` hook, matcher
  `Bash|Edit|Write|NotebookEdit|ExitPlanMode`) — first checks your existing
  Claude Code permission rules (global + project
  `settings.json`/`settings.local.json`) locally, reimplementing Claude
  Code's own rule syntax (`Tool`, `Tool(exact string)`, `Tool(prefix:*)` /
  `Tool(prefix *)`, wildcards anywhere in the pattern). Anything already
  allowed is approved instantly with zero Telegram contact. For anything
  genuinely unmatched, it checks the current mode:
  - `local`: skips Telegram, falls straight back to the normal prompt.
  - `remote`: sends the pending action to Telegram with inline YES/NO/
    switch-to-local buttons (tied to that specific request via
    `callback_data`, so multiple pending requests can't cross-resolve each
    other), waits up to 4 minutes for a reply, and falls back to the normal
    prompt if nothing comes back.
- **Reply with feedback instead of YES/NO.** For *any* pending approval —
  not just plans — a free-text Telegram reply (anything that isn't
  YES/NO/a recognized command) is sent back as the reason the action was
  denied, so Claude sees it on its next turn and can retry differently
  (e.g. reply "no, add --dry-run first" to a Bash command).
- **"✅ Always allow this" button.** For Bash/Edit/Write/NotebookEdit
  prompts (not offered for plan approval — see Known limitations), a third
  button approves this one instance *and* writes a matching **exact-match**
  permission rule (`Bash(<that exact command>)` / `Edit(<that exact file>)`,
  never a broad prefix) to the project's `.claude/settings.local.json` (or
  the global `~/.claude/settings.json` if no project `.claude/` folder is
  found), so the identical command/file stops prompting from then on.
- **Long Edit/Write previews get a file attachment.** The inline Telegram
  message still truncates a long diff/content to 200-300 characters, but if
  anything was actually cut, the full old/new text (Edit) or full file
  content (Write) is also sent as an attached `.txt` file in the same
  message — not a real line-based diff, just clearly labeled OLD/NEW
  sections.
- **Project-tagged messages.** If `cwd` resolves to a project name, prompts
  and `/status`'s pending-request breakdown are prefixed with it — useful
  if you run Claude Code across more than one repo with the same bot.
- **Plan Mode approval, over the same bridge.** When Claude presents a plan
  via `ExitPlanMode`, remote mode sends it to Telegram just like any other
  action — except `ExitPlanMode` takes no plan text as a parameter (Claude
  writes the plan to a file first, then calls it), so the plan text is read
  from the newest `.md` file in your plans directory (`~/.claude/plans/` by
  default, or your `plansDirectory` setting), as long as it was written in
  the last 2 minutes. Tap YES to approve, NO to reject, or **just reply with
  free-text feedback or questions** — that's sent back to Claude as the
  reason the plan was denied, so it revises and re-presents (a fresh Telegram
  message each round, not a live chat — see Known limitations for why that's
  the ceiling of what's possible here).
- **`telegram-listener.js`** — optional always-running background process.
  Only needed for instant replies to `/status`/`/local`/`/remote` sent at any
  time, independent of whether anything is currently pending. When it's
  running, `telegram-approve.js` delegates Telegram polling to it (via small
  request/result files) instead of polling directly itself, so there's never
  more than one process reading updates from the bot at once (Telegram's
  `getUpdates` offset is global per bot token — two independent pollers would
  race for the same updates).
- **A remote-mode request that times out** (4 minutes, no reply) no longer
  just falls back to the local prompt silently — the original Telegram
  message is edited to show "⏰ Timed out — showing local prompt", so your
  Telegram history reflects what actually happened instead of looking
  permanently unresolved.
- **`telegram-sessionstart.js`** (`SessionStart` hook) — a one-way
  "🚀 Session started" ping, symmetric with the Stop ping. Skips
  `resume`/`clear`/`compact`/`fork` starts (only announces a genuinely new
  session) and fires unconditionally like Stop/Notification, not gated by
  mode.
- **`telegram-postrun.js`** (`PostToolUse` **and** `PostToolUseFailure`
  hooks, both matcher `Bash`) — reports whether an approved Bash command
  actually succeeded or failed, with its duration and a tail of
  stdout/stderr (success) or the error text (failure). **Only fires in
  `remote` mode** — unlike Stop/Notification/session-start, pinging after
  every single local Bash call would spam Telegram for a session you're
  already watching in the terminal. (Claude Code's own hook docs don't
  document the exact `PostToolUse`/`PostToolUseFailure` payload shape for
  Bash — this was confirmed empirically against a live session, not
  guessed; see CLAUDE.md.)

Every approval decision is logged to `telegram-approve.log` (auto-rotates
past 2MB) next to the scripts — the bot token itself is redacted from
anything written there, but the log otherwise contains full command/diff
text, per the privacy note above.

## Known limitations

- Only works when Claude Code is driven from a real terminal (the `claude`
  CLI). IDE extensions (e.g. the VS Code extension) run their own permission
  UI that does not currently honor a `PreToolUse` hook's decision — confirmed
  by testing, not just documentation. Sessions there will keep showing local
  prompts as normal; this bridge simply won't intercept them.
- A typed `YES`/`NO` reply (as opposed to tapping a button) applies to the
  *oldest* pending request if more than one is open at once. Button taps are
  tied to the exact request and don't have this ambiguity — prefer tapping
  when several things might be pending together.
- Designed for one bot per person, one chat, one machine. Sharing a single
  bot across multiple people or machines isn't supported out of the box.
- The local permission matcher is a best-effort reimplementation of Claude
  Code's own rule syntax, not the real matching engine — path-glob rules for
  Edit/Write (e.g. directory wildcards) get reasonable but not
  exhaustively-verified handling. A mismatch always fails toward *more*
  prompts, never a silent bypass.
- The lightweight plugin install doesn't include `tg-code` or the listener
  (see [3b](#3b-lightweight-plugin-install-optional-hooks-only)) — use the
  Full setup if you want the complete remote-approval experience.
- **Plan Mode approval is not a live chat.** Claude Code's hook system has no
  way to inject a message mid-turn or intercept Claude's own text as it's
  generated — confirmed by checking, not assumed. A Telegram reply becomes a
  denial reason Claude sees on its *next* turn, so "discussing" a plan is a
  series of separate deny-and-revise round trips, not a real-time back and
  forth.
- **The plan-file lookup is a heuristic, not an exact match.** It picks the
  newest `.md` file in your plans directory written in the last 2 minutes —
  it is *not* scoped to the current session. If you somehow have two
  plan-mode cycles finishing within that window on the same machine, the
  wrong plan could be shown. Not a concern for the normal one-person,
  one-session use this plugin is designed for.
- **"Always allow this" writes a real, persistent rule immediately** — there's
  no undo via Telegram. A mis-tap adds a permanent exact-match allow rule to
  disk; remove it by editing `.claude/settings.local.json` (or the global
  `settings.json`) directly. It's deliberately an *exact* match (the precise
  command or file path, not a category/prefix) to keep the blast radius of a
  mistaken tap as small as possible — it will not silently cover other,
  similar-looking commands.
- The multi-project tag on messages/`/status` only reflects reality when the
  **listener** is running — the no-listener direct-poll path only ever has
  one request in flight at a time anyway, so there's nothing to tell apart.
- **The post-run ping is remote-mode-only, by design** — it fires on every
  Bash call, so unlike Stop/Notification/session-start it would spam
  Telegram constantly if it also fired in local mode. If you want a record
  of every Bash command regardless of mode, this isn't it.

## Troubleshooting

- **`/status` seems stuck / mode won't change no matter what you send.** The
  listener's heartbeat now reflects actual poll-loop progress (fixed a real
  bug where it didn't — see CLAUDE.md), so this should self-resolve within
  ~45 seconds if the loop ever genuinely hangs. If it doesn't:
  `tg-code listen stop` then `tg-code listen start` (or just `tg-code mode
  remote` again, which restarts the listener as a side effect). Check
  `telegram-listener-output.log` for a `poll error:` line right before things
  went quiet — a `409 Conflict` there means something else was also calling
  `getUpdates` with the same bot token at the same time (see "one bot per
  person, one chat, one machine" above — this includes not running two
  copies of the listener, and not testing these scripts with real
  credentials while a real listener is also running).
