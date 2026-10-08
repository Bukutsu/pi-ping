/**
 * pi-ping — Ping only when it's worth it AND you're not looking.
 * 100% pi-native: no wrapper scripts, no GNOME extensions, no OS dependencies.
 *
 * Mechanism (same approach as Codex CLI, via pi's extension API):
 *   1. On session start: enable DECSET 1004 focus reporting on the terminal.
 *   2. Observe stdin through Pi's StdinBuffer without consuming input, because
 *      fullscreen handles focus events before extension input listeners.
 *   3. Track FocusIn (ESC [ I) / FocusOut (ESC [ O). The extension input
 *      listener strips any remaining focus events and detects typed input.
 *   4. On agent_settled (after auto-retries, compaction retries, and queued
 *      follow-ups finish): ping only if terminal is unfocused AND the turn did
 *      real work (>=10s, tool calls, or errors). Runs interrupted mid-flight
 *      (no agent_end ever fired) stay silent. Fallbacks: tmux window visibility
 *      when inside tmux; heuristic tier when desktop focus is unknown.
 *   5. Done marker: on the same qualifying settle, prepend `[!] ` to pi's tab
 *      title (`π - <session> - <cwd>`) via ctx.ui.setTitle (OSC 0). Cleared the
 *      moment the tab gains focus (FocusIn) or a new run starts — the tab reads
 *      `[!] ` precisely between "finished", "unwatched", and "working again".
 *
 * Delivery: OSC 99 (kitty) / OSC 9 (ghostty, iTerm, WezTerm, warp) / OSC 777,
 * plus notify-send fallback on Linux.
 */

import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { appendFileSync } from "node:fs";
import { StdinBuffer } from "@earendil-works/pi-tui";

const OSC9_TERMS = new Set(["ghostty", "iTerm.app", "WezTerm", "warp"]);
const ESC = "\x1b";
type NotificationProtocol = "auto" | "osc9" | "osc99" | "osc777";

function readConfig() {
  const milliseconds = (name: string, fallback: number): number => {
    const value = process.env[name];
    if (value === undefined) return fallback;
    const parsed = Number(value);
    // Node timers clamp larger delays to 1ms.
    if (!/^\d+$/.test(value) || !Number.isInteger(parsed) || parsed > 2_147_483_647) {
      throw new Error(`${name} must be an integer between 0 and 2147483647 (milliseconds).`);
    }
    return parsed;
  };
  const protocol = process.env.PI_PING_PROTOCOL ?? "auto";
  if (!["auto", "osc9", "osc99", "osc777"].includes(protocol)) {
    throw new Error("PI_PING_PROTOCOL must be auto, osc9, osc99, or osc777.");
  }
  const desktopFallback = process.env.PI_PING_DESKTOP_FALLBACK ?? "true";
  if (desktopFallback !== "true" && desktopFallback !== "false") {
    throw new Error("PI_PING_DESKTOP_FALLBACK must be true or false.");
  }
  return {
    body: process.env.PI_PING_BODY,
    errorBody: process.env.PI_PING_ERROR_BODY,
    title: process.env.PI_PING_TITLE,
    errorTitle: process.env.PI_PING_ERROR_TITLE,
    marker: process.env.PI_PING_MARKER ?? "[!] ",
    minWorkMs: milliseconds("PI_PING_MIN_WORK_MS", 10_000),
    minAwayMs: milliseconds("PI_PING_MIN_AWAY_MS", 3_000),
    protocol: protocol as NotificationProtocol,
    desktopFallback: desktopFallback === "true",
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  // One pass: substituted directory names and other values remain literal.
  return template.replace(/\{([a-z_]+)\}/g, (match, key: string) => Object.hasOwn(values, key) ? values[key] : match);
}

/**
 * Strip control characters before embedding a title in OSC 0. Without this, a
 * title containing ESC/BEL (e.g. a hostile repo directory name, or another
 * extension's title) could terminate our OSC early and inject arbitrary
 * escape sequences into the terminal (OSC 52 clipboard writes, etc.).
 */
export function sanitizeTitle(title: string): string {
  return title.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function notifyTitle(ctx: { cwd?: string }, tag?: string): string {
  const base = ctx.cwd ? basename(ctx.cwd) : "";
  const prefix = base ? `Pi (${base})` : "Pi";
  return tag ? `${prefix} (${tag})` : prefix;
}

/**
 * Reconstruct pi's own tab-title format (mirrors interactive-mode
 * `updateTerminalTitle`: `π - <session> - <cwd>`).
 * Stock pi uses "π"; renamed builds may differ.
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
  // Pi delivers bracketed paste as one packet; its contents are user text.
  if (data.startsWith(`${ESC}[200~`)) return undefined;
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

// Pi passes terminal replies through this listener too. They are not typing.
function isTerminalResponse(data: string): boolean {
  return /^\x1b\[(?:[46];\d+;\d+t|\d+;\d+R|[?>]?[\d;]*[cn])$/.test(data) ||
    /^\x1b\][\s\S]*(?:\x07|\x1b\\)$/.test(data) ||
    /^\x1bP[\s\S]*\x1b\\$/.test(data);
}

function tmuxFocused(): Promise<boolean | null> {
  return new Promise((resolve) => {
    const target = process.env.TMUX_PANE ? ["-t", process.env.TMUX_PANE] : [];
    execFile("tmux", ["display-message", "-p", ...target, "#{window_active_clients}"], { timeout: 1000 }, (err, out) => {
      // Unviewed means away; a viewed window does not prove desktop focus.
      resolve(!err && out.trim() === "0" ? false : null);
    });
  });
}

// ── delivery ─────────────────────────────────────────────────────────────

function writeToTty(data: string): void {
  try {
    appendFileSync("/dev/tty", data);
  } catch {
    try {
      process.stdout.write(data);
    } catch {
      // stdout may be closed or broken during teardown/exit
    }
  }
}

function sendNotify(body: string, title: string, config: ReturnType<typeof readConfig>): void {
  title = sanitizeTitle(title);
  body = sanitizeTitle(body);
  let seq: string;
  const protocol = config.protocol === "auto"
    ? process.env.KITTY_WINDOW_ID ? "osc99" : OSC9_TERMS.has(process.env.TERM_PROGRAM ?? "") ? "osc9" : "osc777"
    : config.protocol;
  if (protocol === "osc99") {
    const id = Date.now();
    seq = `${ESC}]99;i=${id}:d=0;${title}${ESC}\\${ESC}]99;i=${id}:p=body;${body}${ESC}\\`;
  } else if (protocol === "osc9") {
    seq = `${ESC}]9;${title}: ${body}\x07`;
  } else {
    // Unknown terminal: OSC 777 may render nothing, so notify-send below covers it.
    seq = `${ESC}]777;notify;${title.replaceAll(";", ",")};${body.replaceAll(";", ",")}\x07`;
  }
  if (process.env.TMUX) seq = `${ESC}Ptmux;${seq.replaceAll(ESC, ESC + ESC)}${ESC}\\`;

  writeToTty(seq);

  // Desktop notification fallback for terminals that don't render OSC 99/9
  // natively. Terminals we send OSC 99/9 to show the notification themselves;
  // notify-send on top of that would duplicate it.
  if (process.platform === "linux" && protocol === "osc777" && config.desktopFallback) {
    execFile("notify-send", ["-a", "Pi", "--", title, body], { timeout: 3000 }, () => {});
  }
}

function initialUsage() {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 };
}

// ── extension ────────────────────────────────────────────────────────────

// One process-wide exit hook; each session registers its teardown in this
// shared Set so session switches and in-process subagents don't pile up
// process listeners. (Shared on purpose, unlike the per-session state below.)
const sessionTeardowns = new Set<() => void>();
function teardownSessions(): void {
  for (const teardown of sessionTeardowns) teardown();
}

export default function (pi: ExtensionAPI): void {
  const config = readConfig();
  // Per-session state — see the note above. Never hoist these to module scope:
  // in-process child sessions (subagents) would share them with the parent.
  const focus = initialFocusState();
  let focusEnabled = false; // DECSET 1004 active in the current session
  let unsubscribeInput: (() => void) | undefined;
  let unsubscribeFocus: (() => void) | undefined;
  let hasTypedInput = false;
  let markerActive = false; // the tab title currently carries our marker
  let runInProgress = false; // agent_start fired, no settle since
  let pendingNotifyTimer: ReturnType<typeof setTimeout> | undefined;
  let notifyGeneration = 0;

  const cancelPendingNotify = () => {
    notifyGeneration++; // invalidate awaited focus queries as well as timers
    if (pendingNotifyTimer) {
      clearTimeout(pendingNotifyTimer);
      pendingNotifyTimer = undefined;
    }
  };

  /** Prepend the done marker to pi's native tab title. */
  const markTitle = (ui: { setTitle(title: string): void }, ctx: ExtensionContext): void => {
    if (runInProgress || !config.marker) return;
    if ((focus.gotFocusEvent || hasTypedInput) && focus.focused) return;
    const base = sanitizeTitle(piTabTitle(ctx));
    if (!base || markerActive) return;
    ui.setTitle(sanitizeTitle(`${config.marker}${base}`));
    markerActive = true;
  };

  /** Restore pi's native tab title. */
  const unmarkTitle = (ui: { setTitle(title: string): void }, ctx: ExtensionContext): void => {
    if (!markerActive) return;
    ui.setTitle(sanitizeTitle(piTabTitle(ctx)));
    markerActive = false;
  };

  const terminalFocused = async (): Promise<boolean | null> => {
    if (focus.gotFocusEvent || hasTypedInput) return focus.focused;
    if (process.env.TMUX) return await tmuxFocused();
    return null;
  };

  let startMs = 0;
  let durationMs = 0;
  let toolCalls = 0;
  let errors = 0;
  let lastAssistant: Extract<AgentEndEvent["messages"][number], { role: "assistant" }> | undefined;
  let usage = initialUsage();
  let agentEnded = false; // agent_end fired for the current run
  const worthNotifying = (dur: number): boolean => agentEnded && lastAssistant?.stopReason !== "aborted" &&
    (lastAssistant?.stopReason === "error" || toolCalls > 0 || errors > 0 || dur >= config.minWorkMs);

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return; // focus reporting only makes sense interactively
    if (sessionTeardowns.size === 0) process.on("exit", teardownSessions);
    sessionTeardowns.add(disableFocus);

    writeToTty(`${ESC}[?1004h`); // ask the terminal for focus events
    focusEnabled = true;

    // Fullscreen consumes focus events before extension input listeners. Observe
    // stdin without consuming it; Pi must still receive events for its own UI.
    unsubscribeFocus?.();
    const buffer = new StdinBuffer();
    const observeInput = (data: string) => {
      const out = scanFocusInput(data, focus);
      const typed = out !== null && !isTerminalResponse(out ?? data);
      if (typed) {
        hasTypedInput = true;
        focus.focused = true;
        focus.unfocusedAt = undefined;
      }
      if (focus.focused) {
        cancelPendingNotify();
        unmarkTitle(ctx.ui, ctx);
      }
    };
    // Apply all focus evidence in stream order, not once through each parser.
    buffer.on("data", observeInput);
    buffer.on("paste", () => observeInput(`${ESC}[200~`));
    const observe = (data: string | Buffer) => buffer.process(data);
    process.stdin.on("data", observe);
    unsubscribeFocus = () => {
      process.stdin.off("data", observe);
      buffer.destroy();
    };

    unsubscribeInput?.();
    unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      // Only strip here. The stdin observer owns focus state, including typing.
      const out = scanFocusInput(data, initialFocusState());
      if (out === null) return { consume: true };
      return out === undefined ? undefined : { data: out };
    });
  });

  // Session-scoped teardown: idempotent, and resets state for the next session.
  const disableFocus = (ctx?: ExtensionContext) => {
    sessionTeardowns.delete(disableFocus);
    if (sessionTeardowns.size === 0) process.off("exit", teardownSessions);
    cancelPendingNotify();
    runInProgress = false;
    startMs = 0;
    durationMs = 0;
    toolCalls = 0;
    errors = 0;
    lastAssistant = undefined;
    usage = initialUsage();
    agentEnded = false;
    hasTypedInput = false;
    unsubscribeFocus?.();
    unsubscribeFocus = undefined;
    if (!focusEnabled && !unsubscribeInput) return;
    if (markerActive && ctx) {
      unmarkTitle(ctx.ui, ctx);
    }
    focusEnabled = false;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    markerActive = false;
    Object.assign(focus, initialFocusState());
    if (sessionTeardowns.size === 0) writeToTty(`${ESC}[?1004l`);
  };

  pi.on("session_shutdown", (_event, ctx) => disableFocus(ctx));

  pi.on("agent_start", (_event, ctx) => {
    cancelPendingNotify();
    if (!runInProgress || !startMs) {
      runInProgress = true;
      startMs = Date.now();
      durationMs = 0;
      toolCalls = 0;
      errors = 0;
      usage = initialUsage();
    }
    lastAssistant = undefined;
    agentEnded = false;
    if (ctx.mode !== "tui") return;
    unmarkTitle(ctx.ui, ctx);
  });

  pi.on("tool_execution_end", (event) => {
    toolCalls++;
    if (event.isError) errors++;
  });

  // Count finalized responses once, not agent_end's potentially overlapping message lists.
  pi.on("message_end", (event) => {
    if (!runInProgress || event.message.role !== "assistant") return;
    const reported = event.message.usage;
    usage.turns++;
    usage.input += reported?.input ?? 0;
    usage.output += reported?.output ?? 0;
    usage.cacheRead += reported?.cacheRead ?? 0;
    usage.cacheWrite += reported?.cacheWrite ?? 0;
    usage.tokens += reported?.totalTokens ?? 0;
    usage.cost += reported?.cost?.total ?? 0;
  });

  // agent_settled has no messages; retain the final assistant response from agent_end.
  pi.on("agent_end", (event) => {
    agentEnded = true;
    lastAssistant = [...(event.messages ?? [])].reverse().find((m) => m.role === "assistant");
  });

  // Ping only once the run has fully settled — no pending auto-retry,
  // compaction retry, or queued follow-up will run afterwards.
  pi.on("agent_settled", async (event, ctx) => {
    if (ctx.mode !== "tui") return; // headless/child session (e.g. subagent) — parent pings instead
    cancelPendingNotify();
    const generation = notifyGeneration;
    runInProgress = false;
    const dur = durationMs = startMs ? Date.now() - startMs : 0;
    if (("aborted" in event && event.aborted) || !worthNotifying(dur)) return;
    const isError = lastAssistant?.stopReason === "error";

    const focusedNow = await terminalFocused();
    if (generation !== notifyGeneration || focusedNow === true) return; // stale or you're looking

    const values = {
      duration: formatDuration(dur),
      duration_ms: String(dur),
      tools: String(toolCalls),
      errors: String(errors),
      status: isError ? "error" : "done",
      dir: basename(ctx.cwd),
      cwd: ctx.cwd,
      session: ctx.sessionManager.getSessionName() ?? "",
      model: lastAssistant?.model ?? ctx.model?.id ?? "",
      provider: lastAssistant?.provider ?? ctx.model?.provider ?? "",
      thinking: lastAssistant?.thinkingLevel ?? ctx.thinkingLevel ?? "",
      stop_reason: lastAssistant?.stopReason ?? "",
      error_message: isError ? lastAssistant?.errorMessage ?? "" : "",
      turns: String(usage.turns),
      input_tokens: String(usage.input),
      output_tokens: String(usage.output),
      cache_read_tokens: String(usage.cacheRead),
      cache_write_tokens: String(usage.cacheWrite),
      tokens: String(usage.tokens),
      cost: usage.cost.toFixed(4),
    };
    const bodyTemplate = (isError ? config.errorBody ?? config.body : config.body)
      ?? (isError ? "Stopped after {duration}" : "Done in {duration}");
    const titleTemplate = (isError ? config.errorTitle ?? config.title : config.title)
      ?? (values.session ? "Pi: {session}" : values.dir ? "Pi: {dir}" : "Pi");
    const body = renderTemplate(bodyTemplate, values);
    const title = renderTemplate(titleTemplate, values);

    const deliver = () => {
      if (generation !== notifyGeneration || runInProgress || ((focus.gotFocusEvent || hasTypedInput) && focus.focused)) return;
      sendNotify(body, title, config);
      markTitle(ctx.ui, ctx);
    };

    // If we have continuous focus tracking, require the configured minimum of
    // unfocused time before alerting so quick window switches stay quiet.
    if (focus.gotFocusEvent && focus.unfocusedAt !== undefined) {
      const awayMs = Date.now() - focus.unfocusedAt;
      if (awayMs < config.minAwayMs) {
        pendingNotifyTimer = setTimeout(() => {
          pendingNotifyTimer = undefined;
          if (focus.gotFocusEvent && !focus.focused && !runInProgress) {
            deliver();
          }
        }, config.minAwayMs - awayMs);
        pendingNotifyTimer.unref?.();
        return;
      }
    }

    deliver();
  });

  pi.registerCommand("notify", {
    description: "Check notification status or send a test: /notify [check|test].",
    getArgumentCompletions: (prefix) => {
      const items = [
        { value: "check", label: "check", description: "Check focus and notification eligibility" },
        { value: "test", label: "test", description: "Send a test notification" },
      ].filter((item) => item.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim() || "check";
      if (action === "test") {
        sendNotify("Desktop and terminal notifications are working.", notifyTitle(ctx, "test"), config);
        ctx.ui.notify("Test notification sent.", "info");
        return;
      }
      if (action !== "check") {
        ctx.ui.notify("Usage: /notify [check|test]", "warning");
        return;
      }
      const f = await terminalFocused();
      const source = focus.gotFocusEvent ? "terminal-focus" : hasTypedInput ? "terminal-input" : process.env.TMUX ? "tmux" : "unknown";
      const dur = runInProgress && startMs ? Date.now() - startMs : durationMs;
      const away = focus.unfocusedAt ? `${Math.round((Date.now() - focus.unfocusedAt) / 1000)}s` : "n/a";
      const focusStr = f === true ? "focused" : f === false ? `unfocused (away ${away})` : "?";
      const would = f !== true && !runInProgress && worthNotifying(dur);
      const msg = `focus ${source}:${focusStr} | tools=${toolCalls} errors=${errors} dur=${Math.round(dur / 1000)}s | would ${would ? "PING" : "silent"}`;
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

  // ── sanitizeTitle / piTabTitle / notifyTitle ──
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
  assert(notifyTitle({ cwd: "/home/u/pi-ping" }) === "Pi (pi-ping)", "notify title with directory");
  assert(notifyTitle({ cwd: "/home/u/pi-ping" }, "error") === "Pi (pi-ping) (error)", "notify error title with directory");
  assert(notifyTitle({ cwd: "/home/u/pi-ping" }, "test") === "Pi (pi-ping) (test)", "notify test title with directory");
  assert(notifyTitle({ cwd: "/" }) === "Pi", "notify fallback title for root cwd");
  assert(notifyTitle({ cwd: "/" }, "error") === "Pi (error)", "notify fallback error title for root cwd");
  assert(notifyTitle({}) === "Pi", "notify fallback title for missing cwd");
  console.log("all self-tests passed");
}
