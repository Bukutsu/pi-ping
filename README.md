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

Focus tracking uses `DECSET 1004` terminal events in both regular and fullscreen Pi modes. Keyboard or pasted input also establishes focus before the first focus event. Under tmux, a window with no viewing clients is also treated as unfocused. A viewed tmux window leaves desktop focus unknown.

Notifications use OSC 99 for Kitty, OSC 9 for Ghostty, iTerm2, WezTerm, and Warp, and OSC 777 for other terminals. Delivery depends on the terminal's notification support and settings. On Linux, the OSC 777 path also tries `notify-send`; that command must be installed for desktop fallback.

Focus support alone does not guarantee notification delivery. There is no native Windows toast backend. Under tmux, terminal notifications also require passthrough to be enabled.

## Commands

- `/notify` or `/notify check`: Check focus source, away time, and whether an alert would fire.
- `/notify test`: Send an immediate test notification.

Type `/notify ` to see subcommand completions. Invalid arguments show usage without sending a notification.

## Configuration

The default notification shows the session name (or directory if unnamed) and elapsed time:

```text
Pi: pi-ping
Done in 12s
```

On final failure, the body reads `Stopped after 1m 04s`. Counts, model details, cost, and raw error text stay out of the default message.

Set environment variables before starting Pi to customize it.

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

Duration settings accept whole milliseconds from `0` to `2147483647`. Invalid numbers, protocols, or boolean values fail at extension load with the variable name in the error. Focus suppression and cancellation handling still apply, including when thresholds are zero.

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

Usage totals cover assistant responses observed during this run, including retries and queued continuations. They reset for the next run. They are not session totals and do not separately include background-agent or compaction usage unless it appears in those responses. Missing usage contributes zero; a zero cost does not establish that the provider billed nothing. Optional metadata is empty when unavailable.

A failed tool call increments `{errors}` but does not make `{status}` become `error` if Pi recovers. Error templates apply only when the final assistant stop reason is `error`. A `length` stop remains `done`; use `{stop_reason}` if you need to distinguish it.

For example:

```bash
export PI_PING_BODY="Completed in {duration}"
export PI_PING_ERROR_BODY="Failed after {duration}"
export PI_PING_TITLE="Pi: {dir}"
export PI_PING_MARKER="(!) "
export PI_PING_MIN_WORK_MS=15000
export PI_PING_MIN_AWAY_MS=5000
```

For more detail:

```bash
export PI_PING_TITLE="Pi: {dir} [{model}]"
export PI_PING_BODY="Completed in {duration}: {turns} turns, {tokens} tokens, USD {cost}"
export PI_PING_ERROR_TITLE="Pi: {dir} needs attention"
export PI_PING_ERROR_BODY="Stopped after {duration}: {error_message}"
```

Error messages can be long and may contain sensitive provider/request details. Include `{error_message}` only if you want that text visible in desktop notifications.

Templates use literal substitution, with no conditionals or expression evaluation. Unknown placeholders stay unchanged. Empty templates produce empty text. Terminal control characters are stripped before delivery.

Custom templates override the defaults, including empty strings. Setting only `PI_PING_BODY` or `PI_PING_TITLE` also applies that template to errors; set the corresponding error template for different wording.

Settings are read when the extension factory loads. Restart Pi after changing its launch environment; `/reload` only picks up changes already present in the running process's environment. `/notify test` uses the configured protocol and fallback but keeps its fixed test message and title.

## Development

```bash
bun install
bun run typecheck
bun run test
```
