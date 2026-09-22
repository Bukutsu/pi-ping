# pi-ping

Focus-aware notifications and tab marker for the [Pi coding agent](https://pi.dev/).

pi-ping alerts you when a run finishes while you are in another window, and marks the terminal tab with `[!] ` until you return. If you are already looking at the terminal, it stays quiet.

Repository: <https://github.com/Bukutsu/pi-ping>

## Install

```bash
pi install npm:@bukutsu/pi-ping
```

Or from GitHub:

```bash
pi install git:github.com/Bukutsu/pi-ping
```

Restart Pi or run `/reload` in your active session.

## What it does

- Notifies only when the terminal is unfocused.
- Adds `[!] ` to Pi's tab title while a finished run is unread, and restores it when you return or type.
- Stays quiet on short turns (under 10s with no tools or errors) and cancelled runs.
- Waits 3 seconds after you switch windows before alerting so quick glances stay silent.
- Alerts once after the run fully settles (no pings during intermediate tool calls or auto-retries).
- Uses native terminal escapes (OSC 9, 99, 777) with `notify-send` fallback on Linux.

## Terminal support

Works out of the box with terminals that support `DECSET 1004` focus events (Ghostty, Kitty, WezTerm, Alacritty, iTerm2, Foot, Warp, Windows Terminal, and tmux).

## Commands

- `/notify-check`: Check focus source, away time, and whether an alert would fire.
- `/notify-test`: Send an immediate test notification.

## Configuration

Set `PI_PING_MARKER` to customize the tab title marker (default: `[!] `):

```bash
export PI_PING_MARKER="(!) "
```

## Development

```bash
bun install
bun run typecheck
bun test
```
