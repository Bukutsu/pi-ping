# pi-ping

A focus-aware notification extension for the [pi coding agent](https://pi.dev/). It alerts you when a Pi run finishes while you are working in another window.

Pi-ping waits until the turn settles completely, skips trivial answers and aborted runs, and uses terminal focus detection to stay quiet when you are already watching the terminal. When a qualifying run finishes in the background, it sends a native terminal notification and prepends `● ` (or custom `PI_PING_MARKER`) to the tab title until you switch back.

Repository: <https://github.com/Bukutsu/pi-ping>

## How it works in practice

```text
1. You run a prompt in Pi:
   Tab title: "π - fix-auth - project"

2. You switch to your browser or editor while Pi works:
   Pi edits 3 files and runs tests (24 seconds).

3. The entire run finishes:
   Notification: "Pi: 3 tool calls, 24s"
   Tab title:    "● π - fix-auth - project"

4. You click back to the terminal:
   The tab title immediately returns to:
   "π - fix-auth - project"
```

## Why pi-ping?

Most notification extensions either ping on every single message or rely on external scripts. Pi-ping avoids the noise:

| Scenario | Typical notification extensions | pi-ping |
|---|---|---|
| Looking at the terminal | Sends a notification anyway | Stays silent via DECSET 1004 focus detection |
| Momentary workspace switch | Triggers an immediate notification | Stays silent during quick glances (>=3s continuous away debounce) |
| Quick reply with no tool calls | Sends a notification | Stays silent (<10s, 0 tool calls, 0 errors) |
| Auto-retry or context compaction | Pings on every intermediate step | Pings once after `agent_settled` fires |
| Prompt cancelled with Escape | Often fires a false completion alert | Stays silent |
| Spotting finished tabs | Renames tab permanently or does nothing | Adds temporary `● ` prefix, clears on focus |
| Setup requirements | Background daemons or extra packages | Native ANSI escape sequences only |

## When you do not need it

Skip pi-ping if:

- you keep your terminal visible on a dedicated monitor while Pi runs;
- you prefer an audible bell after every single prompt, including short one-line replies; or
- you need window focus automation or mobile push notifications.

## Gating and delivery

### When it notifies

- Skips runs under 10 seconds with no tool calls and no errors.
- Skips runs aborted with Escape.
- Stays silent if the process exited mid-flight without an `agent_end` event.
- Waits for `agent_settled` so retries and compactions finish before pinging.
- Requires continuous away time (>=3s) so momentary workspace glances stay quiet.
- Prioritizes terminal focus reporting first, tmux window focus second, and turn duration heuristics as a fallback.

### Notification protocols

- `OSC 99` on kitty
- `OSC 9` on Ghostty, iTerm2, WezTerm, and Warp
- `OSC 777` on other compatible terminals
- `notify-send` on Linux when the running terminal does not support escape notifications

### Tab title markers

When Pi finishes in an unfocused window, pi-ping queries the current terminal title with `CSI 21 t` and prepends `● ` (configurable via `PI_PING_MARKER`, e.g. `export PI_PING_MARKER="[!] "`).

- It decorates the active title rather than replacing it.
- It clears automatically as soon as the tab receives focus or a new run starts.
- On terminals that do not answer title queries (such as Windows Terminal or Ghostty without title reporting enabled), it falls back to Pi's default title format.

## Terminal support

| Terminal | Focus detection | Notification | Tab title marker |
|---|---|---|---|
| Ghostty | Native (DECSET 1004) | OSC 9 / OSC 777 | Supported (set `title-report = true` in config) |
| Kitty | Native (DECSET 1004) | OSC 99 | Supported out of the box |
| WezTerm | Native (DECSET 1004) | OSC 9 / OSC 777 | Supported out of the box |
| iTerm2 | Native (DECSET 1004) | OSC 9 | Supported (fallback title format) |
| Warp | Native (DECSET 1004) | OSC 9 | Supported (fallback title format) |
| tmux | `#{window_focused}` | Wrapped escape sequences | Supported |
| Other Linux terminals | Fallback heuristic | `notify-send` fallback | Supported (fallback title format) |

## Requirements and limits

- Runs in Pi interactive TUI mode.
- Focus detection requires a terminal that supports DECSET 1004 or tmux.
- Ghostty disables title queries by default. To enable tab title decoration, add `title-report = true` to `~/.config/ghostty/config`.
- Pi extensions run with your user permissions. Always inspect the code before installing third-party packages.

## Installation

From npm:

```bash
pi install npm:@bukutsu/pi-ping
```

From GitHub:

```bash
pi install git:github.com/Bukutsu/pi-ping
```

After installing, restart Pi or run `/reload` in your active session.

## Commands

- `/notify-check`: Print active focus source, continuous away duration, recent turn stats, and whether a notification would fire.
- `/notify-test`: Send an immediate test notification to verify terminal and desktop alerts.

## Testing

```bash
bun run typecheck   # tsc --strict against the pi extension API
bun run test        # self-test: focus scanner and title-reply scanner
```
