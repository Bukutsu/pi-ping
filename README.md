# pi-ping

Focus-aware notification and tab-marker extension for the [pi coding agent](https://pi.dev/). It alerts you only when a run finishes while you are working in another window.

Zero daemons, zero OS binaries, zero external dependencies. Pure ANSI terminal native.

Repository: <https://github.com/Bukutsu/pi-ping>

## Why pi-ping stands out

Most notification extensions either ping on every message, fire during auto-retries, or require OS-specific scripts (`osascript`, `hyprctl`, `dunst`). **pi-ping** does things the Unix way:

1. **Zero OS dependencies**: Uses native terminal escape sequences (`DECSET 1004`, `OSC 9/99/777`, `CSI 21 t`). Runs seamlessly across macOS, Linux, Windows, and tmux without helper daemons.
2. **True focus detection**: Intercepts in-stream terminal focus events (`\x1b[I` / `\x1b[O`). If you are already looking at the terminal, it stays completely silent.
3. **Settled-state gating (`agent_settled`)**: Only pings when Pi is genuinely waiting on you — never interrupts mid-run during auto-retries, tool loops, or context compaction.
4. **Noise-free**:
   - **Trivial turn filter**: Skips short replies (<10s, 0 tools, 0 errors).
   - **Away debounce (3s)**: Skips momentary glances or rapid window switching.
5. **Append-only tab marker**: Temporarily prepends `[!] ` to the existing tab title while unwatched, and restores your title the moment you click back into the terminal.
6. **Project-aware**: Notification titles include the active directory name (e.g. `Pi (my-project)`).

## How it works

```text
1. You run a prompt in Pi:
   Tab title: "π - fix-auth - my-project"

2. You switch to your browser or editor while Pi works:
   Pi runs tools and edits code (24s).

3. The entire run finishes while you are away:
   Notification: "Pi (my-project): 3 tool calls, 24s"
   Tab title:    "[!] π - fix-auth - my-project"

4. You click back to the terminal:
   The tab title immediately restores:
   "π - fix-auth - my-project"
```

## Comparison

| Feature | Typical notification extensions | pi-ping |
|---|---|---|
| **Looking at terminal** | Pings anyway | **Silent** (native DECSET 1004 focus detection) |
| **Momentary Alt-Tab** | Immediate notification | **Silent** (>=3s continuous away debounce) |
| **Quick 1-sentence reply** | Pings anyway | **Silent** (<10s, 0 tools, 0 errors) |
| **Auto-retries & Compaction** | Pings on every intermediate step | **Pings once** after run fully settles (`agent_settled`) |
| **Cancelled with Escape** | Often triggers false alert | **Silent** |
| **Tab status** | Overwrites title permanently with emojis | **Decorates title with `[!] `**, clears on focus |
| **Dependencies** | Requires `osascript`, `hyprctl`, or Python | **Zero dependencies** (pure ANSI escape sequences) |

## Terminal support

| Terminal | Focus detection | Notification | Tab title marker |
|---|---|---|---|
| **Ghostty** | Native (DECSET 1004) | OSC 9 / OSC 777 | Supported (set `title-report = true` in config) |
| **Kitty** | Native (DECSET 1004) | OSC 99 | Supported out of the box |
| **WezTerm** | Native (DECSET 1004) | OSC 9 / OSC 777 | Supported out of the box |
| **iTerm2** | Native (DECSET 1004) | OSC 9 | Supported (fallback title) |
| **Warp** | Native (DECSET 1004) | OSC 9 | Supported (fallback title) |
| **tmux** | `#{window_focused}` | Wrapped escape sequences | Supported |
| **Linux (other)** | Fallback heuristic | `notify-send` | Supported (fallback title) |

## Installation

From npm:

```bash
pi install npm:@bukutsu/pi-ping
```

From GitHub:

```bash
pi install git:github.com/Bukutsu/pi-ping
```

Restart Pi or run `/reload` in your active session.

## Commands

- `/notify-check`: Check active focus source, continuous away duration, turn stats, and whether a ping would fire.
- `/notify-test`: Send an immediate test notification to verify terminal and desktop alerts.

## Configuration (optional)

- `PI_PING_MARKER`: Customize the tab marker prefix (default: `[!] `).
  ```bash
  export PI_PING_MARKER="(!) "
  ```

## Testing

```bash
bun run typecheck   # tsc --strict against the pi extension API
bun run test        # self-test: focus scanner and title-reply scanner
```

