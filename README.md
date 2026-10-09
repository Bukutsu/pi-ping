# pi-ping

Desktop notifications for the [Pi coding agent](https://pi.dev/) when you step away.

When a qualifying run finishes while you are away, pi-ping sends a notification and adds `[!] ` to the terminal tab title. It stays quiet while the terminal is known to be focused. Return to the tab, type, or start another run to clear the marker.

If focus is unknown, qualifying runs still alert.

Only interactive TUI sessions are supported. Pi still imports the extension in RPC, JSON, and print modes, but notifications, focus tracking, and /notify stay inactive.

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

## When it pings

A run qualifies if it lasts at least 10 seconds, uses a tool, or has an error. Short runs with no tools or errors stay silent, as do cancelled runs.

The notification waits until the run has fully settled, including retries and queued follow-ups. Intermediate tool calls and auto-retries do not send separate alerts.

When terminal focus events are available, you must have been away for at least 3 seconds. Returning before that delay expires cancels the pending alert.

## Terminal support

Focus tracking works in regular and fullscreen Pi modes through `DECSET 1004` terminal events. Typing or pasting also establishes focus before the first event arrives.

Under tmux, a window with no viewing clients counts as unfocused. A viewed window alone cannot tell pi-ping whether the desktop terminal is focused. Terminal notifications under tmux require passthrough to be enabled.

Notification delivery uses the terminal's native escape sequences:

| Terminal | Protocol |
| --- | --- |
| Kitty | OSC 99 |
| Ghostty, iTerm2, WezTerm, Warp | OSC 9 |
| Other terminals | OSC 777 |

On Linux, the OSC 777 path also tries `notify-send`. Install that command if you need the desktop fallback.

Delivery depends on your terminal's notification support and settings. A terminal can report focus without supporting notifications. There is no native Windows toast backend.

## Commands

- `/notify` or `/notify check` shows the focus source, away time, and run eligibility.
- `/notify test` sends a notification immediately, even while focused.

Type `/notify ` for subcommand completions. Invalid arguments show usage and send nothing.

## Configuration

By default, the notification shows the session name and elapsed time. Unnamed sessions use the directory name:

```text
Pi: pi-ping
Done in 12s
```

A final failure uses `Stopped after 1m 04s`. The defaults omit counts, model details, cost, and raw error text.

Set these environment variables before starting Pi:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_PING_BODY` | `Done in {duration}` | Notification body template. |
| `PI_PING_ERROR_BODY` | Uses `PI_PING_BODY` if set, otherwise `Stopped after {duration}` | Body template when the final assistant stop reason is `error`. |
| `PI_PING_TITLE` | `Pi: {session}` if named, otherwise `Pi: {dir}` (or `Pi` at filesystem root) | Notification title template. Does not change Pi's tab title. |
| `PI_PING_ERROR_TITLE` | Uses `PI_PING_TITLE`, or the built-in title | Title template when the final assistant stop reason is `error`. |
| `PI_PING_MARKER` | `[!] ` | Tab title marker. Set to an empty string to disable marking. |
| `PI_PING_MIN_WORK_MS` | `10000` | Minimum run duration to alert without tools or errors. Tools and errors still qualify immediately. |
| `PI_PING_MIN_AWAY_MS` | `3000` | Minimum continuous away time when terminal focus events are available. |
| `PI_PING_PROTOCOL` | `auto` | Terminal notification protocol: `auto`, `osc9`, `osc99`, or `osc777`. |
| `PI_PING_DESKTOP_FALLBACK` | `true` | Set to `false` to disable Linux `notify-send` fallback on the OSC 777 path. |

Duration settings accept whole milliseconds from `0` to `2147483647`. Invalid numbers, protocols, or boolean values stop the extension from loading. The error names the variable.

Zero thresholds still respect focus suppression and cancellation.

### Message templates

`PI_PING_BODY`, `PI_PING_ERROR_BODY`, `PI_PING_TITLE`, and `PI_PING_ERROR_TITLE` support these placeholders:

| Placeholder | Value |
| --- | --- |
| `{duration}` | Rounded elapsed time: `0s`, `12s`, `1m 04s`. Durations of a minute or more use minutes and zero-padded seconds. |
| `{duration_ms}` | Elapsed run duration in whole milliseconds, excluding any notification delay. |
| `{tools}` | Tool call count, including zero. |
| `{errors}` | Failed tool call count, including zero. Provider failures are reflected in `{status}`, not this count. |
| `{status}` | `done` or `error`, based on the final assistant stop reason. |
| `{dir}` | Working directory basename. |
| `{cwd}` | Full working-directory path. |
| `{session}` | Session name, or empty if unnamed. |
| `{model}` | Final assistant's model ID, falling back to the selected model. |
| `{provider}` | Final assistant's provider, falling back to the selected provider. |
| `{thinking}` | Final assistant's Pi thinking level, falling back to the selected level. |
| `{stop_reason}` | Final assistant's stop reason, such as `stop`, `length`, or `error`. |
| `{error_message}` | Final assistant's error text when the stop reason is `error`; otherwise empty. |
| `{turns}` | Finalized assistant response count, including intermediate tool-use responses and failed attempts. |
| `{input_tokens}` | Sum of reported input tokens. |
| `{output_tokens}` | Sum of reported output tokens, including reasoning tokens where reported. |
| `{cache_read_tokens}` | Sum of reported prompt-cache read tokens. |
| `{cache_write_tokens}` | Sum of reported prompt-cache write tokens. |
| `{tokens}` | Sum of Pi's reported total tokens. |
| `{cost}` | Sum of Pi's estimated costs in USD, with four decimal places and no currency symbol, such as `0.0324`. |

Usage totals cover assistant responses observed in the current run, including retries and queued continuations. They reset when the next run starts. Background-agent and compaction usage is included only if it appears in those responses.

Missing usage counts as zero. A zero cost does not prove the provider billed nothing. Optional metadata is empty when unavailable.

Error templates apply only when the final assistant stop reason is `error`. A failed tool call increments `{errors}`, but the status remains `done` if Pi recovers. A `length` stop also counts as `done`; use `{stop_reason}` to distinguish it.

To change the wording, marker, and thresholds:

```bash
export PI_PING_BODY="Completed in {duration}"
export PI_PING_ERROR_BODY="Failed after {duration}"
export PI_PING_TITLE="Pi: {dir}"
export PI_PING_MARKER="(!) "
export PI_PING_MIN_WORK_MS=15000
export PI_PING_MIN_AWAY_MS=5000
```

To include model details, usage, and error text:

```bash
export PI_PING_TITLE="Pi: {dir} [{model}]"
export PI_PING_BODY="Completed in {duration}: {turns} turns, {tokens} tokens, USD {cost}"
export PI_PING_ERROR_TITLE="Pi: {dir} needs attention"
export PI_PING_ERROR_BODY="Stopped after {duration}: {error_message}"
```

Error text can be long and contain sensitive provider or request details. Use `{error_message}` only if you want those details in desktop notifications.

Templates substitute placeholder values literally. They do not evaluate expressions or support conditionals. Unknown placeholders stay unchanged, and terminal control characters are stripped before delivery.

Custom templates replace the defaults. An empty string produces empty text. Setting `PI_PING_BODY` or `PI_PING_TITLE` also changes error notifications unless you set the corresponding error template.

Settings are read when the extension factory loads. Restart Pi after changing its launch environment. `/reload` can only read environment changes already present in the running process.

`/notify test` uses your protocol and fallback settings, with a fixed test message and title.

## Development

```bash
bun install
bun run typecheck
bun run test
```
