# pi-ping

Get a desktop notification when [Pi](https://pi.dev/) finishes a run while you're away from the terminal. The tab title also gets a `[!] ` marker until you come back.

Works in interactive TUI sessions only.

## Install

```bash
pi install npm:@bukutsu/pi-ping
```

Then restart Pi or run `/reload`.

## When it pings

- The run took 10s or more, used a tool, or ended with an error.
- You weren't looking for at least 3s.
- The run wasn't cancelled.

If pi-ping can't tell whether you're looking, it pings anyway.

## Commands

- `/notify` shows focus state and whether the last run would ping.
- `/notify test` sends a test notification.

## Settings

Set these before starting Pi.

| Variable | Default |
| --- | --- |
| `PI_PING_TITLE` | `Pi: {session}` or `Pi: {dir}` |
| `PI_PING_BODY` | `Done in {duration}` |
| `PI_PING_ERROR_TITLE` | same as title |
| `PI_PING_ERROR_BODY` | `Stopped after {duration}` |
| `PI_PING_MARKER` | `[!] ` (empty to turn off) |
| `PI_PING_MIN_WORK_MS` | `10000` |
| `PI_PING_MIN_AWAY_MS` | `3000` |
| `PI_PING_PROTOCOL` | `auto` (`osc9`, `osc99`, `osc777`) |
| `PI_PING_DESKTOP_FALLBACK` | `true` (Linux `notify-send`) |

Titles and bodies can use these placeholders:

`{duration}` `{duration_ms}` `{status}` `{stop_reason}` `{error_message}` `{tools}` `{errors}` `{turns}` `{dir}` `{cwd}` `{session}` `{model}` `{provider}` `{thinking}` `{input_tokens}` `{output_tokens}` `{cache_read_tokens}` `{cache_write_tokens}` `{tokens}` `{cost}`

Example:

```bash
export PI_PING_BODY="Done in {duration}, {tokens} tokens, USD {cost}"
```

`{error_message}` can contain provider or request details, so only add it if you're fine seeing that in notifications.

## Terminals

| Terminal | Protocol |
| --- | --- |
| Kitty | OSC 99 |
| Ghostty, iTerm2, WezTerm, Warp | OSC 9 |
| Others | OSC 777, plus `notify-send` on Linux |

Under tmux, turn on passthrough so notifications reach your terminal.

## Development

```bash
bun install
bun run typecheck
bun run test
```
