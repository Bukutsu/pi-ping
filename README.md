# pi-ping

A 100% pi-native notification extension for the [pi coding agent](https://pi.dev/).
Pings only when a turn finishes, you are **not** looking at the terminal, and real work was done.
It also marks the terminal tab as done (prepends `! ` to the tab title) while the finished
run is the latest state.

No wrapper scripts, no GNOME shell extensions, no external daemons.

## How it works

1. **Terminal Focus via DECSET 1004**:
   On session start, enables DECSET 1004 focus reporting.
   Listens to raw input via `ctx.ui.onTerminalInput`, catching `FocusIn` (`ESC [ I`) and `FocusOut` (`ESC [ O`), and consuming them before pi's TUI parser sees them.

2. **Anti-Spam & Smart Gating**:
   - **Trivial turns**: Skips turns <10s with no tool calls and no errors.
   - **Aborted turns**: Skips when you hit Escape.
   - **Focused terminal**: Stays completely silent when you are looking.
   - **Fully settled**: Pings on `agent_settled`, so auto-retries, compaction retries, and queued follow-ups finish before the ping fires.
   - **Interrupted runs**: Runs killed mid-flight (no `agent_end` ever fired) stay silent — no "done" ping for work that never finished.

3. **Fallback Ladder**:
   - Primary: Terminal focus reporting (`Ghostty`, `kitty`, `iTerm2`, `WezTerm`, etc.)
   - Secondary: `tmux` (`window_focused`) if running in `tmux`
   - Fallback: Heuristic gating (duration + tool calls + errors) if focus reporting is unsupported

4. **Multi-Protocol Delivery**:
   Sends native escape notifications based on terminal:
   - `OSC 99` for `kitty`
   - `OSC 9` for `Ghostty`, `iTerm2`, `WezTerm`, `Warp`
   - `OSC 777` for standard terminals
   - `notify-send` fallback on Linux

5. **Done Tab Marker** (same gating as the ping):
   When a qualifying run settles, queries the terminal for its current window
   title (native XTWINOPS `CSI 21 t`; reply is `OSC l <title>`), then prepends
   `! ` to it via OSC 0 — **append-only**, so it decorates pi's own title
   (`π - <session> - <cwd>`) or whatever another extension set, never
   replacing it. The marker is removed at the next `agent_start`, but only
   when the title is exactly what we set, so a tab reads `!` precisely
   between *finished* and *working again*.

   - Works in terminals that answer the title query: `xterm`, `kitty`,
     `WezTerm`, `Ghostty` (see below), and inside `tmux` (which relays it).
   - **Ghostty**: title reporting is **off by default** — add
     `title-report = true` to `~/.config/ghostty/config` and restart, or the
     marker is never set.
   - Terminals that don't answer at all (e.g. `iTerm2`, Windows Terminal)
     fall back to pi's own naming (`! π - <session> - <cwd>`) — the tradeoff
     is that on those terminals a rename by another extension would be
     replaced rather than decorated.

## Installation

```bash
pi install ~/Projects/pi-ping        # registered as a local package
```

Or copy the file directly:

```bash
cp ~/Projects/pi-ping/index.ts ~/.pi/agent/extensions/pi-ping.ts
```

## Commands

- `/notify-check`: Check current focus state, turn stats, and whether a notification would trigger.

## Testing

```bash
bun run typecheck   # tsc --strict against the pi extension API
bun run test        # self-test: focus scanner + title-reply scanner
```
