# pi-ping

A notification extension for the [pi coding agent](https://pi.dev/). It alerts you when a useful Pi run finishes while you are looking somewhere else.

Pi-ping waits for the run to fully settle, ignores trivial and aborted turns, and uses terminal focus when available. When a qualifying run finishes in the background, it sends a native terminal notification and marks the tab title with `! `.

Repository: <https://github.com/Bukutsu/pi-ping>

## How it looks in practice

```text
1. You submit a prompt in Pi:
   Tab title: "π - fix-auth - project"

2. You switch to your browser or editor while Pi works:
   Pi edits 3 files and runs a test suite (24 seconds).

3. When the entire run finishes:
   Desktop banner: "Pi: 3 tool calls, 24s"
   Tab title:      "! π - fix-auth - project"

4. You click back into the terminal:
   FocusIn event fires. The tab title immediately restores to:
   "π - fix-auth - project"
```

## Why use pi-ping?

| Scenario | Standard notifiers | pi-ping |
|---|---|---|
| You are actively reading the terminal | Sends notification anyway | Silent (DECSET 1004 focus detection) |
| Short 2-second reply with no tool calls | Sends notification | Silent (<10s, no tools, no errors) |
| Multi-turn runs, compaction, or retries | Multiple intermediate pings | Exactly one ping when `agent_settled` fires |
| Run aborted with Escape | Often sends false "done" ping | Silent |
| Finding finished tabs among many tabs | Permanent title overwrite or nothing | Temporary `! ` prefix, clears on focus |
| System overhead | Extra OS daemons or background scripts | 100% native ANSI escape sequences |

## When you do not need it

You probably do not need Pi-ping if:

- you keep Pi visible on a dedicated screen at all times;
- you want a notification or sound after every single prompt, including one-word answers; or
- you need click-to-focus window management or mobile push alerts.

## What it does

### Smart gating

- **Trivial turn filter**: Turns under 10 seconds with zero tool calls and zero errors stay quiet.
- **Escape abort filter**: Aborted runs never notify.
- **Interrupted run filter**: If a process is terminated mid-flight without `agent_end`, it stays silent.
- **Fully settled gating**: Listens to `agent_settled`, ensuring retries and compaction finish before alerting.
- **Focus detection hierarchy**: Checks terminal focus reporting first, tmux window focus second, and falls back to work duration and tool counts when neither is present.

### Native notification delivery

- `OSC 99` for kitty
- `OSC 9` for Ghostty, iTerm2, WezTerm, and Warp
- `OSC 777` for standard terminals
- `notify-send` fallback on Linux when running in terminals without native escape notifications

### Safe tab title decoration

When the terminal is unfocused, pi-ping queries the terminal for its current title via `CSI 21 t` and prepends `! `.

- Append-only: it decorates the existing title rather than replacing it.
- Reverts automatically when the tab receives focus or when a new agent run starts.
- On terminals that do not report titles (such as Windows Terminal or Ghostty without title reporting enabled), it falls back to Pi's standard title format.

## Terminal compatibility

| Environment | Focus Reporting | Notification | Done Tab Marker |
|---|---|---|---|
| Ghostty | Native (DECSET 1004) | OSC 9 / OSC 777 | Supported (set `title-report = true` in config) |
| Kitty | Native (DECSET 1004) | OSC 99 | Supported out of the box |
| WezTerm | Native (DECSET 1004) | OSC 9 / OSC 777 | Supported out of the box |
| iTerm2 | Native (DECSET 1004) | OSC 9 | Supported (fallback title format) |
| Warp | Native (DECSET 1004) | OSC 9 | Supported (fallback title format) |
| tmux | `#{window_focused}` | Wrapped escape sequences | Supported |
| Other Linux terminals | Work heuristic | `notify-send` fallback | Supported (fallback title format) |

## Requirements and limits

- Runs in Pi's interactive TUI mode.
- Focus detection requires a terminal supporting DECSET 1004 focus reporting or tmux.
- Ghostty tab title reporting is disabled by default in Ghostty. Add `title-report = true` to `~/.config/ghostty/config` if you want title decoration rather than title fallback.
- Extensions execute with Pi permissions. Review source code before installing packages.

## Installation

From npm:

```bash
pi install npm:@bukutsu/pi-ping
```

From GitHub:

```bash
pi install git:github.com/Bukutsu/pi-ping
```

After installing, restart Pi or run `/reload` in an active session.

## Commands

- `/notify-check`: Check the active focus source, turn stats, and whether a notification would trigger right now.

## Testing

```bash
bun run typecheck   # tsc --strict against the pi extension API
bun run test        # self-test: focus scanner and title-reply scanner
```
