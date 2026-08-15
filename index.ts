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
 *  5. Done marker: on the same qualifying settle, query the terminal for its
 *      current window title (XTWINOPS `CSI 21 t`, reply `OSC l <title> ST`),
 *      then prepend "! " via OSC 0 — append-only, so it decorates pi's own
 *      title (`π - <session> - <cwd>`) or whatever another extension set,
 *      never replacing it. Terminals that don't answer the query (e.g.
 *      ghostty without `title-report = true`, iTerm2, Windows Terminal) fall
 *      back to pi's own naming. Same focus gate as the ping: marked only
 *      while you're NOT looking, and cleared the moment the tab gains focus
 *      (FocusIn) or a new run starts — the tab reads "!" precisely between
 *      "finished", "unwatched", and "working again".
 *
 * Delivery: OSC 99 (kitty) / OSC 9 (ghostty, iTerm, WezTerm, warp) / OSC 777,
 * plus notify-send fallback on Linux.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { appendFileSync } from "node:fs";

const MIN_WORK_MS = 10_000;
const MIN_AWAY_MS = 3_000;
const OSC9_TERMS = new Set(["ghostty", "iTerm.app", "WezTerm", "warp"]);
const ESC = "\x1b";
const TITLE_QUERY_TIMEOUT_MS = 250; // terminals that don't answer CSI 21 t stay silent
const TITLE_BUF_CAP = 512; // safety cap for a fragmented title reply
const DONE_MARKER = process.env.PI_PING_MARKER ?? "● "; // prepended to the tab title while the run is done

/**
 * Strip control characters before embedding a title in OSC 0. Without this, a
 * title containing ESC/BEL (e.g. a hostile repo directory name, or another
 * extension's title) could terminate our OSC early and inject arbitrary
 * escape sequences into the terminal (OSC 52 clipboard writes, etc.).
 */
export function sanitizeTitle(title: string): string {
  return title.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Reconstruct pi's own tab-title format (mirrors interactive-mode
 * `updateTerminalTitle`: `π - <session> - <cwd>`). Used only as a fallback
 * when the terminal can't report its current title, so the marker still works
 * on terminals without title reporting (e.g. ghostty without `title-report`).
 * Stock pi uses "π"; renamed builds may differ — the query path is primary.
 */
export function piTabTitle(ctx: {
  cwd: string;
  sessionManager: { getSessionName(): string | undefined };
}): string {
  const base = basename(ctx.cwd);
  const session = ctx.sessionManager.getSessionName();
  return session ? `π - ${session} - ${base}` : `π - ${base}`;
}

// ── focus state ──────────────────────────────────────────────────────────
// NOTE: focus state must be per-session, not module-level. pi loads the
// extension module once per cwd and reuses the same factory for in-process
// child sessions (pi-background-agents subagents run in the parent cwd by
// default), so module-level `let`s are SHARED between the parent and child
// sessions. A child's session_shutdown would otherwise call disableFocus()
// and tear down the parent's focus tracking. Keep this state inside the
// factory closure below.

export type FocusState = {
  focused: boolean;
  gotFocusEvent: boolean;
  unfocusedAt?: number;
};

/** Fresh per-session focus state: assume focused until a focus event says otherwise (matches Codex). */
export function initialFocusState(): FocusState {
  return { focused: true, gotFocusEvent: false, unfocusedAt: undefined };
}

/** Strip FocusIn/FocusOut from raw input, updating `state`.
 *  Returns null when fully consumed, the stripped string, or undefined if unchanged. */
export function scanFocusInput(data: string, state: FocusState, now = Date.now()): string | null | undefined {
  let out = "";
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    if (data.startsWith(`${ESC}[I`, i)) {
      state.focused = true;
      state.gotFocusEvent = true;
      state.unfocusedAt = undefined;
      out += data.slice(last, i);
      last = i + 3;
      i += 2;
    } else if (data.startsWith(`${ESC}[O`, i)) {
      if (state.focused || state.unfocusedAt === undefined) {
        state.unfocusedAt = now;
      }
      state.focused = false;
      state.gotFocusEvent = true;
      out += data.slice(last, i);
      last = i + 3;
      i += 2;
    }
  }
  out += data.slice(last);
  if (out === data) return undefined; // no focus events — pass through
  return out.length === 0 ? null : out;
}

/** Buffer for a title reply that arrives split across input chunks. */
export type TitleScanState = { buf: string };

/**
 * Strip an `OSC l <title> ST|BEL` reply (answer to `CSI 21 t`) from raw input,
 * calling `onTitle` with the extracted title. Same contract as scanFocusInput:
 * undefined = no reply in this chunk, null = chunk fully consumed, string =
 * remainder. A reply split across chunks is held in `state.buf` and recombined
 * on the next call.
 */
export function scanTitleReply(
  data: string,
  state: TitleScanState,
  onTitle: (title: string) => void,
): string | null | undefined {
  const input = state.buf + data;
  const start = input.indexOf(`${ESC}]l`);
  if (start === -1) {
    state.buf = "";
    return undefined;
  }
  const body = start + 3;
  const st = input.indexOf(`${ESC}\\`, body);
  const bel = input.indexOf("\x07", body);
  const end = st !== -1 && (bel === -1 || st < bel) ? st : bel;
  if (end === -1) {
    // Reply may continue in the next chunk: hold the tail, pass the prefix on.
    const tail = input.slice(start);
    state.buf = tail.length > TITLE_BUF_CAP ? "" : tail;
    const prefix = input.slice(0, start);
    return prefix.length === 0 ? null : prefix;
  }
  state.buf = "";
  onTitle(input.slice(body, end));
  const after = input.slice(end + (input[end] === "\x07" ? 1 : 2));
  const remainder = input.slice(0, start) + after;
  return remainder.length === 0 ? null : remainder;
}

function tmuxFocused(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("tmux", ["display-message", "-p", "#{window_focused}"], (_err, out) => {
      const v = (out ?? "").trim();
      resolve(v === "1" ? true : v === "0" ? false : null);
    });
  });
}

// ── delivery ─────────────────────────────────────────────────────────────

function writeToTty(data: string): void {
  try {
    appendFileSync("/dev/tty", data);
  } catch {
    process.stdout.write(data);
  }
}

function sendNotify(body: string, title = "Pi"): void {
  let seq: string;
  let terminalNotifies = true;
  if (process.env.KITTY_WINDOW_ID) {
    const id = Date.now();
    seq = `${ESC}]99;i=${id}:d=0;${title}${ESC}\\${ESC}]99;i=${id}:p=body;${body}${ESC}\\`;
  } else if (OSC9_TERMS.has(process.env.TERM_PROGRAM ?? "")) {
    seq = `${ESC}]9;${title}: ${body}\x07`;
  } else {
    // Unknown terminal: OSC 777 may render nothing, so notify-send below covers it.
    seq = `${ESC}]777;notify;${title};${body}\x07`;
    terminalNotifies = false;
  }
  if (process.env.TMUX) seq = `${ESC}Ptmux;${seq.replaceAll(ESC, ESC + ESC)}${ESC}\\`;

  writeToTty(seq);

  // Desktop notification fallback for terminals that don't render OSC 99/9
  // natively. Terminals we send OSC 99/9 to show the notification themselves;
  // notify-send on top of that would duplicate it.
  if (process.platform === "linux" && !terminalNotifies) {
    execFile("notify-send", ["-a", "Pi", title, body], () => {});
  }
}

// ── extension ────────────────────────────────────────────────────────────

// One process-wide exit hook; each session registers its teardown in this
// shared Set so session switches and in-process subagents don't pile up
// process listeners. (Shared on purpose, unlike the per-session state below.)
const sessionTeardowns = new Set<() => void>();
process.on("exit", () => {
  for (const teardown of sessionTeardowns) teardown();
});

export default function (pi: ExtensionAPI): void {
  // Per-session state — see the note above. Never hoist these to module scope:
  // in-process child sessions (subagents) would share them with the parent.
  const focus = initialFocusState();
  let focusEnabled = false; // DECSET 1004 active in the current session
  let unsubscribeInput: (() => void) | undefined;
  // Tab-title marker state (also per-session — see the note above).
  const titleScan: TitleScanState = { buf: "" };
  let pendingTitle: ((title: string | null) => void) | undefined;
  let markedTitle: string | undefined; // original title we decorated with DONE_MARKER
  let markerActive = false; // the tab title currently carries our marker
  let runInProgress = false; // agent_start fired, no settle since
  let pendingNotifyTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelPendingNotify = () => {
    if (pendingNotifyTimer) {
      clearTimeout(pendingNotifyTimer);
      pendingNotifyTimer = undefined;
    }
  };

  /** Ask the terminal for its current window title (native XTWINOPS query). */
  const queryTitle = (): Promise<string | null> => {
    if (pendingTitle) return Promise.resolve(null); // previous query still in flight
    return new Promise((resolve) => {
      let done = false;
      const finish = (t: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pendingTitle = undefined;
        titleScan.buf = ""; // drop any partial reply left over from this query
        resolve(t);
      };
      const timer = setTimeout(() => finish(null), TITLE_QUERY_TIMEOUT_MS);
      pendingTitle = finish;
      writeToTty(`${ESC}[21t`);
    });
  };

  /** Prepend the done marker to the current title; never replaces it. */
  const markTitle = async (ui: { setTitle(title: string): void }, ctx: ExtensionContext): Promise<void> => {
    const title = await queryTitle();
    if (runInProgress) return; // a new run started while we were querying
    // The user may have focused the tab during the query — then they're
    // looking, and the marker must not appear (it would only be cleared
    // again by the FocusIn handler below).
    if (focus.gotFocusEvent && focus.focused) return;
    if (title) {
      // Query answered: decorate the actual title (pi's or another extension's).
      const clean = sanitizeTitle(title);
      if (!clean || clean === markedTitle || clean.startsWith(DONE_MARKER)) return;
      markedTitle = clean;
      ui.setTitle(`${DONE_MARKER}${clean}`);
      markerActive = true;
      return;
    }
    // Terminal can't report its title: fall back to pi's own naming, which is
    // the default tab title anyway. (Tradeoff: on such terminals the marker
    // replaces, not decorates — a rename by another extension is lost.)
    const fallback = sanitizeTitle(piTabTitle(ctx));
    if (!fallback || fallback === markedTitle || fallback.startsWith(DONE_MARKER)) return;
    markedTitle = fallback;
    ui.setTitle(`${DONE_MARKER}${fallback}`);
    markerActive = true;
  };

  /** Remove the marker, but only when the title is still ours. */
  const unmarkTitle = async (ui: { setTitle(title: string): void }): Promise<void> => {
    if (!markerActive || !markedTitle) return;
    const title = await queryTitle();
    if (title && title.startsWith(DONE_MARKER)) {
      ui.setTitle(title.slice(DONE_MARKER.length));
    } else if (title === null) {
      // Query unanswered: can't verify, but a stale marker is worse, so restore
      // the title we set (best effort; concurrent rename is rare).
      ui.setTitle(markedTitle);
    }
    // Query answered with a different title: another extension owns it — the
    // marker is gone either way, so stop trying to clear it.
    markerActive = false;
  };
  const terminalFocused = async (): Promise<boolean | null> => {
    if (focus.gotFocusEvent) return focus.focused;
    if (process.env.TMUX) return await tmuxFocused();
    return null;
  };
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
        const wasFocused = focus.focused;
        let out = scanFocusInput(data, focus);
        if (out !== null) {
          // A title reply can arrive interleaved with focus events.
          const titleOut = pendingTitle
            ? scanTitleReply(out ?? data, titleScan, (t) => pendingTitle?.(t))
            : undefined;
          if (titleOut !== undefined) out = titleOut;
        }
        // The tab just became focused: user is looking — cancel pending alert and drop marker.
        if (!wasFocused && focus.focused) {
          cancelPendingNotify();
          if (markerActive) {
            void unmarkTitle(ctx.ui);
          }
        }
        if (out === null) return { consume: true };
        return out === undefined ? undefined : { data: out };
      });
    } catch {
      // non-interactive UI (rpc/print)
    }
  });

  // Session-scoped teardown: idempotent, and resets state for the next session.
  const disableFocus = () => {
    cancelPendingNotify();
    if (!focusEnabled && !unsubscribeInput) return;
    focusEnabled = false;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    pendingTitle?.(null); // don't leave the settle handler awaiting a dead session
    titleScan.buf = "";
    Object.assign(focus, initialFocusState());
    writeToTty(`${ESC}[?1004l`);
  };
  pi.on("session_shutdown", () => {
    sessionTeardowns.delete(disableFocus);
    disableFocus();
  });
  sessionTeardowns.add(disableFocus);

  pi.on("agent_start", (_event, ctx) => {
    cancelPendingNotify();
    runInProgress = true;
    startMs = Date.now();
    toolCalls = 0;
    errors = 0;
    lastStopReason = undefined;
    agentEnded = false;
    // Tab no longer done: clear our marker, but only if the title is exactly
    // what we set — never clobber pi's or another extension's naming.
    if (ctx.mode !== "tui" || !markedTitle) return;
    void unmarkTitle(ctx.ui);
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

    // Only a qualifying settle clears runInProgress: a trivial/aborted settle
    // must leave it true so a stale markTitle() continuation from the previous
    // run can't land mid-way through this one.
    runInProgress = false;

    const focusedNow = await terminalFocused();
    if (focusedNow === true) return; // terminal is focused — you're looking

    const isError = lastStopReason === "error";
    const parts = [];
    if (toolCalls > 0) parts.push(`${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`);
    if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
    if (dur >= 1000) parts.push(`${Math.round(dur / 1000)}s`);
    const body = parts.join(", ") || (isError ? "error" : "done");
    const title = isError ? "Pi (error)" : "Pi";

    const deliver = async () => {
      sendNotify(body, title);
      // Done marker: only while you're NOT looking — it clears as soon as the
      // tab gains focus (FocusIn in the input handler above).
      await markTitle(ctx.ui, ctx);
    };

    // If we have continuous focus tracking, require at least MIN_AWAY_MS of
    // unfocused time before alerting so quick window switches stay quiet.
    if (focus.gotFocusEvent && focus.unfocusedAt !== undefined) {
      const awayMs = Date.now() - focus.unfocusedAt;
      if (awayMs < MIN_AWAY_MS) {
        cancelPendingNotify();
        pendingNotifyTimer = setTimeout(() => {
          pendingNotifyTimer = undefined;
          if (focus.gotFocusEvent && !focus.focused && !runInProgress) {
            void deliver();
          }
        }, MIN_AWAY_MS - awayMs);
        return;
      }
    }

    await deliver();
  });

  pi.registerCommand("notify-check", {
    description: "Report focus source, turn stats, and whether a ping would fire.",
    handler: async (_args, ctx) => {
      const f = await terminalFocused();
      const source = focus.gotFocusEvent ? "terminal-focus" : process.env.TMUX ? "tmux" : "unknown";
      const dur = startMs ? Date.now() - startMs : 0;
      const away = focus.unfocusedAt ? `${Math.round((Date.now() - focus.unfocusedAt) / 1000)}s` : "n/a";
      const focusStr = f === true ? "focused" : f === false ? `unfocused (away ${away})` : "?";
      const would = f !== true && (toolCalls > 0 || errors > 0 || dur >= MIN_WORK_MS);
      const msg = `focus ${source}:${focusStr} | tools=${toolCalls} errors=${errors} dur=${Math.round(dur / 1000)}s | would ${would ? "PING" : "silent"}`;
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("notify-test", {
    description: "Send an immediate test notification.",
    handler: async (_args, ctx) => {
      sendNotify("Desktop and terminal notifications are working.", "Pi (test)");
      ctx.ui.notify("Test notification sent.", "info");
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

  const fs = initialFocusState();
  const t = (input: string, expected: string | null | undefined, label: string) => {
    const got = scanFocusInput(input, fs);
    assert(got === expected, `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
  };

  t("hello", undefined, "no focus events pass through");
  t(`${ESC}[I`, null, "FocusIn consumed");
  t(`${ESC}[O`, null, "FocusOut consumed");
  t(`a${ESC}[Ib`, "ab", "FocusIn stripped mid-stream");
  t(`${ESC}[Ix${ESC}[O`, "x", "both events stripped");
  t(`${ESC}[I${ESC}[O`, null, "only focus events fully consumed");
  assert(fs.focused === false, "focus state follows last event (FocusOut)");
  assert(fs.gotFocusEvent === true, "gotFocusEvent set");

  const fs2 = initialFocusState();
  scanFocusInput(`${ESC}[O`, fs2, 1000);
  assert(fs2.focused === false && fs2.unfocusedAt === 1000, "FocusOut sets unfocusedAt timestamp");
  scanFocusInput(`${ESC}[O`, fs2, 2000);
  assert(fs2.unfocusedAt === 1000, "consecutive FocusOut preserves original unfocusedAt timestamp");
  scanFocusInput(`${ESC}[I`, fs2, 3000);
  assert(fs2.focused === true && fs2.unfocusedAt === undefined, "FocusIn resets unfocusedAt timestamp");

  // Fresh sessions must not inherit focus state: the module instance is
  // shared across in-process sessions, so state has to be per-factory-call.
  const other = initialFocusState();
  assert(other.focused === true && other.gotFocusEvent === false, "fresh session starts with clean focus state");

  // ── scanTitleReply ──
  const ts: TitleScanState = { buf: "" };
  let got: string | undefined;
  const rt = (input: string, state: TitleScanState, expected: string | null | undefined, title: string | undefined, label: string) => {
    got = undefined;
    const r = scanTitleReply(input, state, (t) => {
      got = t;
    });
    assert(r === expected, `${label}: got ${JSON.stringify(r)}, want ${JSON.stringify(expected)}`);
    assert(got === title, `${label}: title ${JSON.stringify(got)}, want ${JSON.stringify(title)}`);
  };

  rt("hello", ts, undefined, undefined, "no reply passes through");
  rt(`${ESC}]lpi - cwd${ESC}\\`, ts, null, "pi - cwd", "ST-terminated reply extracted");
  rt(`a${ESC}]lT${ESC}\\b`, ts, "ab", "T", "reply stripped mid-stream");
  rt(`a${ESC}]lT\x07b`, ts, "ab", "T", "BEL-terminated reply stripped");
  rt(`${ESC}]lfoo]bar${ESC}\\`, ts, null, "foo]bar", "title containing ] kept intact");
  rt(`x${ESC}]lpi`, ts, "x", undefined, "split reply: prefix passes, tail buffered");
  rt(` - cwd${ESC}\\y`, ts, "y", "pi - cwd", "split reply recombined across chunks");
  rt(`${ESC}]lT`, ts, null, undefined, "incomplete reply consumes chunk");
  assert(ts.buf === `${ESC}]lT`, "incomplete tail held in buffer");
  rt(`\x07`, ts, null, "T", "terminator in next chunk completes reply");
  assert(ts.buf === "", "buffer drained after completion");
  const big = "z".repeat(600);
  rt(`y${ESC}]l${big}`, ts, "y", undefined, "oversized tail dropped, prefix passes");
  assert(ts.buf === "", "oversized tail not buffered");

  // ── sanitizeTitle / piTabTitle ──
  assert(sanitizeTitle("pi - cwd") === "pi - cwd", "clean title untouched");
  assert(sanitizeTitle("a\x1b]2;evil\x07b") === "a]2;evilb", "control chars stripped (no OSC injection)");
  assert(sanitizeTitle("\x1b\x07\x00") === "", "fully control title emptied");
  const fakeCtx = (name: string | undefined, cwd: string) => ({
    cwd,
    sessionManager: { getSessionName: () => name },
  });
  assert(piTabTitle(fakeCtx("my session", "/home/u/proj")) === "π - my session - proj", "fallback title with session");
  assert(piTabTitle(fakeCtx(undefined, "/home/u/proj")) === "π - proj", "fallback title without session");
  assert(piTabTitle(fakeCtx(undefined, "/")) === "π - ", "fallback title for root cwd (mirrors pi's own basename behavior)");
  console.log("all self-tests passed");
}
