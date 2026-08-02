# pi-notify-when-away

A 100% pi-native notification extension for the [pi coding agent](https://pi.dev/).
Pings only when a turn finishes, you are **not** looking at the terminal, and real work was done.

No wrapper scripts, no GNOME shell extensions, no external daemons.

## How it works

1. **Terminal Focus via DECSET 1004**:
   On session start, enables DECSET 1004 focus reporting.
   Listens to raw input via `ctx.ui.onTerminalInput`, catching `FocusIn` (`ESC [ I`) and `FocusOut` (`ESC [ O`), and consuming them before pi's TUI parser sees them.

2. **Anti-Spam & Smart Gating**:
   - **Trivial turns**: Skips turns <10s with no tool calls and no errors.
   - **Aborted turns**: Skips when you hit Escape.
   - **Focused terminal**: Stays completely silent when you are looking.

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

## Installation

```bash
cp -r ~/Projects/pi-notify-when-away ~/.pi/agent/extensions/
```

Or copy `index.ts` directly into `~/.pi/agent/extensions/notify-when-away.ts`.

## Commands

- `/notify-check`: Check current focus state, turn stats, and whether a notification would trigger.
