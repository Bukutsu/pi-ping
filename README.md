# pi-ping

Focus-aware notifications and tab marker for the [Pi coding agent](https://pi.dev/).

pi-ping alerts you when a run finishes while you are in another window, and marks the terminal tab with `[!] ` until you return. It stays quiet when terminal focus reporting confirms you are looking. If desktop focus is unknown, qualifying runs still alert.

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

- Suppresses notifications when the terminal is known to be focused.
- Adds `[!] ` to Pi's tab title while a finished run is unread, and restores it when you return or type.
- Stays quiet on short turns (under 10s with no tools or errors) and cancelled runs.
- With terminal focus events, waits until you have been away for 3 seconds before alerting.
- Alerts once after the run fully settles (no pings during intermediate tool calls or auto-retries).
- Uses native terminal escapes (OSC 9, 99, 777) with `notify-send` fallback on Linux.

## Terminal support

Focus tracking uses `DECSET 1004` terminal events. Under tmux, a window with no viewing clients is also treated as unfocused. A viewed tmux window leaves desktop focus unknown.

Notifications use OSC 99 for Kitty, OSC 9 for Ghostty, iTerm2, WezTerm, and Warp, and OSC 777 for other terminals. Delivery depends on the terminal's notification support and settings. On Linux, the OSC 777 path also tries `notify-send`; that command must be installed for desktop fallback.

Focus support alone does not guarantee notification delivery. There is no native Windows toast backend. Under tmux, terminal notifications also require passthrough to be enabled.

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
bun run test
```
