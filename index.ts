/**
 * pi-ping — Ping only when it's worth it AND you're not looking.
 * 100% pi-native: no wrapper scripts, no GNOME extensions, no OS dependencies.
 *
 * Mechanism (same approach as Codex CLI, via pi's extension API):
 *   1. On session start: enable DECSET 1004 focus reporting on the terminal.
 *   2. Subscribe to ctx.ui.onTerminalInput — pi passes raw input to extensions
 *      before its own TUI parser, with `{ consume: true }` support.
 *   3. Terminal sends FocusIn (ESC [ I) / FocusOut (ESC [ O); we strip and
 *      consume them so pi's parser never sees them, tracking focus state.
 *   4. On agent_settled (after auto-retries, compaction retries, and queued
 *      follow-ups finish): ping only if terminal is unfocused AND the turn did
 *      real work (>=10s, tool calls, or errors). Runs interrupted mid-flight
 *      (no agent_end ever fired) stay silent. Fallbacks: tmux window_focused
 *      when inside tmux; heuristic tier when no focus source exists.
 *
 * Delivery: OSC 99 (kitty) / OSC 9 (ghostty, iTerm, WezTerm, warp) / OSC 777,
 * plus notify-send fallback on Linux.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";

const MIN_WORK_MS = 10_000;
const OSC9_TERMS = new Set(["ghostty", "iTerm.app", "WezTerm", "warp"]);
const ESC = "\x1b";

// ── focus state ──────────────────────────────────────────────────────────

let focused = true; // assume focused until a focus event says otherwise (matches Codex)
let gotFocusEvent = false;
let focusEnabled = false; // DECSET 1004 active in the current session
let unsubscribeInput: (() => void) | undefined;

/** Strip FocusIn/FocusOut from raw input, updating focus state.
 *  Returns null when fully consumed, the stripped string, or undefined if unchanged. */
export function scanFocusInput(data: string): string | null | undefined {
  let out = "";
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    if (data.startsWith(`${ESC}[I`, i)) {
      focused = true;
      gotFocusEvent = true;
      out += data.slice(last, i);
      last = i + 3;
      i += 2;
    } else if (data.startsWith(`${ESC}[O`, i)) {
      focused = false;
      gotFocusEvent = true;
      out += data.slice(last, i);
      last = i + 3;
      i += 2;
    }
  }
  out += data.slice(last);
  if (out === data) return undefined; // no focus events — pass through
  return out.length === 0 ? null : out;
}

function tmuxFocused(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("tmux", ["display-message", "-p", "#{window_focused}"], (_err, out) => {
      const v = (out ?? "").trim();
      resolve(v === "1" ? true : v === "0" ? false : null);
    });
  });
}

async function terminalFocused(): Promise<boolean | null> {
  if (gotFocusEvent) return focused;
  if (process.env.TMUX) return await tmuxFocused();
  return null;
}

// ── delivery ─────────────────────────────────────────────────────────────

function writeToTty(data: string): void {
  try {
    const fd = openSync("/dev/tty", "w");
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
  } catch {
    process.stdout.write(data);
  }
}

function sendNotify(body: string): void {
  let seq: string;
  let terminalNotifies = true;
  if (process.env.KITTY_WINDOW_ID) {
    seq = `${ESC}]99;i=1:d=0;Pi${ESC}\\${ESC}]99;i=1:p=body;${body}${ESC}\\`;
  } else if (OSC9_TERMS.has(process.env.TERM_PROGRAM ?? "")) {
    seq = `${ESC}]9;Pi: ${body}\x07`;
  } else {
    // Unknown terminal: OSC 777 may render nothing, so notify-send below covers it.
    seq = `${ESC}]777;notify;Pi;${body}\x07`;
    terminalNotifies = false;
  }
  if (process.env.TMUX) seq = `${ESC}Ptmux;${seq.split(ESC).join(ESC + ESC)}${ESC}\\`;

  writeToTty(seq);

  // Desktop notification fallback for terminals that don't render OSC 99/9
  // natively. Terminals we send OSC 99/9 to show the notification themselves;
  // notify-send on top of that would duplicate it.
  if (process.platform === "linux" && !terminalNotifies) {
    execFile("notify-send", ["-a", "Pi", "Pi", body], () => {});
  }
}

// ── extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  let startMs = 0;
  let toolCalls = 0;
  let errors = 0;
  let lastStopReason: string | undefined;
  let agentEnded = false; // agent_end fired for the current run

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return; // focus reporting only makes sense interactively

    writeToTty(`${ESC}[?1004h`); // ask the terminal for focus events
    focusEnabled = true;

    try {
      unsubscribeInput = ctx.ui.onTerminalInput((data) => {
        const out = scanFocusInput(data);
        if (out === null) return { consume: true };
        return out === undefined ? undefined : { data: out };
      });
    } catch {
      // non-interactive UI (rpc/print)
    }
  });

  // Session-scoped teardown: idempotent, and resets state for the next session.
  const disableFocus = () => {
    if (!focusEnabled && !unsubscribeInput) return;
    focusEnabled = false;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    focused = true;
    gotFocusEvent = false;
    writeToTty(`${ESC}[?1004l`);
  };
  pi.on("session_shutdown", disableFocus);
  process.on("exit", disableFocus);

  pi.on("agent_start", () => {
    startMs = Date.now();
    toolCalls = 0;
    errors = 0;
    lastStopReason = undefined;
    agentEnded = false;
  });

  pi.on("tool_execution_end", (event) => {
    toolCalls++;
    if (event.isError) errors++;
  });

  // agent_settled has no messages; remember the final stop reason from agent_end.
  pi.on("agent_end", (event) => {
    agentEnded = true;
    const lastAssistant = [...(event.messages ?? [])].reverse().find((m) => m.role === "assistant");
    lastStopReason = lastAssistant?.stopReason;
  });

  // Ping only once the run has fully settled — no pending auto-retry,
  // compaction retry, or queued follow-up will run afterwards.
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui") return; // headless/child session (e.g. subagent) — parent pings instead
    const dur = startMs ? Date.now() - startMs : 0;

    if (!agentEnded) return; // run interrupted mid-flight — never finished, stay silent
    if (lastStopReason === "aborted") return; // turn was aborted
    if (toolCalls === 0 && errors === 0 && dur < MIN_WORK_MS) return; // trivial turn

    const focusedNow = await terminalFocused();
    if (focusedNow === true) return; // terminal is focused — you're looking

    const parts = [];
    if (toolCalls > 0) parts.push(`${toolCalls} tool calls`);
    if (errors > 0) parts.push(`${errors} errors`);
    if (dur >= 1000) parts.push(`${Math.round(dur / 1000)}s`);
    sendNotify(parts.join(", ") || "done");
  });

  pi.registerCommand("notify-check", {
    description: "Report focus source, turn stats, and whether a ping would fire.",
    handler: async (_args, ctx) => {
      const f = await terminalFocused();
      const source = gotFocusEvent ? "terminal-focus" : process.env.TMUX ? "tmux" : "unknown";
      const dur = startMs ? Date.now() - startMs : 0;
      const would = f !== true && (toolCalls > 0 || errors > 0 || dur >= MIN_WORK_MS);
      const msg = `focus ${source}:${f ?? "?"} | tools=${toolCalls} errors=${errors} dur=${Math.round(dur / 1000)}s | would ${would ? "PING" : "silent"}`;
      ctx.ui.notify(msg, "info");
    },
  });
}

// ── self-test (PI_NOTIFY_SELFTEST=1 bun index.ts) ─────────────────────────

if (process.env.PI_NOTIFY_SELFTEST) {
  const assert = (cond: boolean, label: string) => {
    if (cond) {
      console.log(`ok - ${label}`);
    } else {
      console.error(`FAIL - ${label}`);
      process.exit(1);
    }
  };

  const t = (input: string, expected: string | null | undefined, label: string) => {
    const got = scanFocusInput(input);
    assert(got === expected, `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
  };

  t("hello", undefined, "no focus events pass through");
  t(`${ESC}[I`, null, "FocusIn consumed");
  t(`${ESC}[O`, null, "FocusOut consumed");
  t(`a${ESC}[Ib`, "ab", "FocusIn stripped mid-stream");
  t(`${ESC}[Ix${ESC}[O`, "x", "both events stripped");
  t(`${ESC}[I${ESC}[O`, null, "only focus events fully consumed");
  // Snapshot through a call so TS does not narrow the module-level `let` state.
  const state = () => ({ focused, gotFocusEvent });
  assert(state().focused === false, "focus state follows last event (FocusOut)");
  assert(state().gotFocusEvent === true, "gotFocusEvent set");
  console.log("all self-tests passed");
}
