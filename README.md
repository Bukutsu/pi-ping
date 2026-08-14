# pi-ping

A notification extension for the [pi coding agent](https://pi.dev/). It tells you when a useful Pi run has finished while you are looking somewhere else.

Pi-ping waits for the run to fully settle, ignores trivial and aborted turns, and uses terminal focus when it can detect it. When a qualifying run finishes away from the terminal, it sends a native terminal notification and adds `! ` to the tab title.

Repository: <https://github.com/Bukutsu/pi-ping>

## Why use it?

Pi is useful when you can leave it alone for a while. The problem is knowing when it is worth coming back to the terminal.

Pi-ping is for you if you:

- switch to another window while Pi works;
- run Pi in more than one terminal tab;
- want one notification after the whole run finishes, not during an automatic retry or compaction;
- want quick, no-tool turns to stay quiet; or
- want the finished tab to be easy to spot without renaming it permanently.

The tab marker is temporary. It appears only while the run is finished and the terminal is unfocused. It disappears when you look at the tab or start another run.

## When you do not need it

You probably do not need Pi-ping if you keep Pi visible, want a bell after every turn, or already have a notification extension that does exactly what you want.

Pi-ping is also not a general approval or question-alert system. It reports qualifying completed runs. It does not add click-to-focus actions, a desktop notification service, or a required background daemon.

## What it does

### Decides when to notify

- Skips turns shorter than 10 seconds when they had no tool calls or errors.
- Skips aborted turns.
- Waits for `agent_settled`, so automatic retries, compaction retries, and queued follow-ups finish first.
- Stays silent for interrupted runs where no `agent_end` event was received.
- Uses terminal focus reporting first, tmux window focus second, and a work-based heuristic when neither is available.

### Sends native terminal notifications

- `OSC 99` for kitty
- `OSC 9` for Ghostty, iTerm2, WezTerm, and Warp
- `OSC 777` for other terminals that support it
- `notify-send` as a Linux fallback when the terminal does not provide native notifications

No wrapper scripts, GNOME extensions, or external daemons are required.

### Marks the finished tab

When the terminal is unfocused, pi-ping asks for the current title and prepends `! `. It decorates the existing title instead of replacing it when the terminal supports title reporting. The marker is cleared when the tab gains focus or a new run starts.

The title marker works in terminals that answer the title query, including xterm, kitty, WezTerm, Ghostty, and tmux. Ghostty requires this setting:

```ini
title-report = true
```

Terminals that do not answer the title query, such as iTerm2 and Windows Terminal, fall back to Pi's own title format.

## Installation

From npm:

```bash
pi install npm:@bukutsu/pi-ping
```

From a local checkout:

```bash
pi install ~/Projects/pi-ping
```

Or copy the file directly:

```bash
cp ~/Projects/pi-ping/index.ts ~/.pi/agent/extensions/pi-ping.ts
```

## Commands

- `/notify-check`: Check the current focus source, turn statistics, and whether a notification would trigger.

## Testing

```bash
bun run typecheck   # tsc --strict against the pi extension API
bun run test        # self-test: focus scanner and title-reply scanner
```
