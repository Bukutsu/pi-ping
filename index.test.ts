import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realFs = await import("node:fs");
const realChildProcess = await import("node:child_process");
const { TuiAltScreen, StdinBuffer } = await import("@earendil-works/pi-tui");
const writes: string[] = [];
const commands: { name: string; args: string[]; callback: Function }[] = [];
mock.module("node:fs", () => ({ ...realFs, appendFileSync: (_path: string, data: string) => writes.push(data) }));
mock.module("node:child_process", () => ({ ...realChildProcess, execFile: (name: string, args: string[], _options: unknown, callback: Function) => {
  commands.push({ name, args, callback });
  if (name !== "tmux") callback(null, "");
} }));
const env = { ...process.env };
const { default: extension, initialFocusState, scanFocusInput } = await import("./index.ts");
process.env = { ...env };
const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let now = 100_000;
let timers: Map<object, () => void>;
const ESC = "\x1b";
let fixtures: ReturnType<typeof setup>[] = [];
function setup(mode = "tui", cwd = "/tmp/project", tui?: TuiAltScreen) {
  const handlers = new Map<string, Function>();
  const registeredCommands = new Map<string, { handler: Function; getArgumentCompletions?: Function }>();
  const titles: string[] = [];
  const notices: string[] = [];
  let input: Function | undefined;
  let unsubscribed = 0;
  const ctx = { mode, cwd, sessionManager: { getSessionName: (): string | undefined => undefined }, model: undefined as { id: string; provider: string } | undefined, thinkingLevel: undefined as string | undefined, ui: {
    onTerminalInput: (fn: Function) => {
      input = fn;
      const unsubscribe = tui?.addInputListener((data) => fn(data));
      return () => { unsubscribe?.(); input = undefined; unsubscribed++; };
    },
    setTitle: (title: string) => titles.push(title), notify: (text: string) => notices.push(text),
  } };
  extension({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (name: string, cmd: any) => registeredCommands.set(name, cmd) } as any);
  const fixture = { ctx, titles, notices,
    emit: (name: string, event: any = {}) => handlers.get(name)?.(event, ctx),
    input: (data: string) => { process.stdin.emit("data", data); return input?.(data); },
    command: (name: string, args = "") => registeredCommands.get(name)!.handler(args, ctx),
    commandNames: () => [...registeredCommands.keys()],
    complete: (prefix: string) => registeredCommands.get("notify")!.getArgumentCompletions?.(prefix),
    unsubscribed: () => unsubscribed,
  };
  fixtures.push(fixture);
  return fixture;
}
function finish(f: ReturnType<typeof setup>, reason = "stop") {
  f.emit("agent_end", { messages: [{ role: "assistant", stopReason: reason }] });
  return f.emit("agent_settled");
}
function away(f: ReturnType<typeof setup>) {
  f.emit("session_start");
  f.input(`${ESC}[O`);
  now += 4000;
  writes.length = 0;
}
beforeEach(() => {
  for (const key of ["TMUX", "TMUX_PANE", "KITTY_WINDOW_ID", "TERM_PROGRAM", ...Object.keys(process.env).filter((key) => key.startsWith("PI_PING_"))]) delete process.env[key];
  writes.length = 0; commands.length = 0; now = 100_000; timers = new Map();
  Date.now = () => now;
  globalThis.setTimeout = ((fn: () => void, delay: number) => { const timer = { delay, unref() {} }; timers.set(timer, fn); return timer; }) as any;
  globalThis.clearTimeout = ((timer: object) => { timers.delete(timer); }) as any;
});
afterEach(() => {
  for (const f of fixtures) f.emit("session_shutdown");
  fixtures = [];
  Date.now = realNow; globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
  process.env = { ...env };
});

describe("notify command", () => {
  test("one command offers check and test completions", () => {
    const f = setup();
    expect(f.commandNames()).toEqual(["notify"]);
    expect(f.complete("")).toEqual([
      { value: "check", label: "check", description: "Check focus and notification eligibility" },
      { value: "test", label: "test", description: "Send a test notification" },
    ]);
    expect(f.complete("t")?.map((item: { value: string }) => item.value)).toEqual(["test"]);
    expect(f.complete("test extra")).toBeNull();
  });
  test("no arguments checks status; invalid arguments never send a notification", async () => {
    const f = setup(); away(f);
    await f.command("notify"); const status = f.notices.at(-1);
    await f.command("notify", " check "); expect(f.notices.at(-1)).toBe(status);
    expect(status).toContain("focus terminal-focus:unfocused");
    for (const args of ["unknown", "test extra", "check extra"]) {
      await f.command("notify", args);
      expect(f.notices.at(-1)).toBe("Usage: /notify [check|test]");
    }
    expect(writes).toEqual([]); expect(commands).toEqual([]);
  });
});

describe("run contracts", () => {
  test("notify check keeps settled duration and uses notification eligibility", async () => {
    const f = setup(); away(f); f.emit("agent_start"); await finish(f);
    now += 60_000; await f.command("notify", "check");
    expect(f.notices.at(-1)).toContain("dur=0s | would silent");
    f.emit("agent_start"); f.emit("tool_execution_end", { isError: true }); await finish(f, "aborted");
    await f.command("notify", "check"); expect(f.notices.at(-1)).toEndWith("would silent");
    f.emit("agent_start"); await finish(f, "error"); await f.command("notify", "check");
    expect(f.notices.at(-1)).toEndWith("would PING");
  });
  test("fast provider errors notify", async () => {
    const f = setup(); away(f); f.emit("agent_start"); await finish(f, "error");
    expect(writes.some((w) => w.includes("]777;"))).toBe(true);
  });
  test("new run cancels a pending tmux focus lookup", async () => {
    process.env.TMUX = "test";
    const f = setup(); f.emit("session_start"); writes.length = 0;
    f.emit("agent_start"); f.emit("tool_execution_end", { isError: false });
    const settled = finish(f); f.emit("agent_start");
    commands.find((c) => c.name === "tmux")!.callback(null, "0\n"); await settled;
    expect(writes).toEqual([]);
  });
  test("typed input cancels pending tmux focus lookup", async () => {
    process.env.TMUX = "test";
    const f = setup(); f.emit("session_start"); writes.length = 0;
    f.emit("agent_start"); f.emit("tool_execution_end", { isError: false });
    const settled = finish(f); f.input("hello");
    commands.find((c) => c.name === "tmux")!.callback(null, "0\n"); await settled;
    expect(writes).toEqual([]);
  });
  test("shutdown cancels in-flight focus queries", async () => {
    process.env.TMUX = "test";
    const f = setup(); f.emit("session_start"); f.emit("agent_start"); f.emit("tool_execution_end", { isError: false });
    const settled = finish(f); f.emit("session_shutdown"); writes.length = 0;
    commands.find((c) => c.name === "tmux")!.callback(null, "0\n"); await settled;
    expect(writes).toEqual([]);
  });
  test("short successful runs and aborted runs stay silent", async () => {
    const f = setup(); away(f); f.emit("agent_start"); await finish(f);
    f.emit("agent_start"); f.emit("tool_execution_end", { isError: true }); await finish(f, "aborted");
    expect(writes).toEqual([]);
  });
  test("retries aggregate tools until settlement", async () => {
    process.env.PI_PING_BODY = "{tools} tool calls";
    const f = setup(); away(f); f.emit("agent_start"); f.emit("tool_execution_end", { isError: false });
    f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
    now += 1000; f.emit("agent_start"); f.emit("tool_execution_end", { isError: false }); await finish(f);
    expect(writes.filter((w) => w.includes("]777;"))).toHaveLength(1);
    expect(writes.join("")).toContain("2 tool calls");
  });
});

describe("terminal boundaries", () => {
  test("fullscreen focus events reach the observer without bypassing viewport handling", async () => {
    const terminal = { columns: 80, rows: 24, write() {}, hideCursor() {}, showCursor() {} };
    const ui = new TuiAltScreen(terminal as any);
    const f = setup("tui", "/tmp/project", ui);
    f.emit("session_start");
    let received = 0;
    ui.addInputListener(() => { received++; });
    const input = (data: string) => {
      ui.handleTerminalInput(data);
      process.stdin.emit("data", data);
    };
    input(`${ESC}[O`);
    expect(received).toBe(0); // Fullscreen still consumes the event.
    now += 4000;
    writes.length = 0;
    f.emit("agent_start"); await finish(f, "error");
    expect(writes.at(-1)).toContain("]777;notify;");
    input(`${ESC}[I`);
    await f.command("notify", "check");
    expect(f.notices.at(-1)).toContain("terminal-focus:focused");
    writes.length = 0;
    f.emit("agent_start"); await finish(f, "error");
    expect(writes).toEqual([]);
  });
  test("batched focus events and typing retain stream order in either listener order", async () => {
    for (const piFirst of [true, false]) {
      const f = setup();
      // Feed the UI parser independently of the raw observer.
      const uiParser = new StdinBuffer();
      let handler: Function;
      f.ctx.ui.onTerminalInput = (fn: Function) => { handler = fn; return () => {}; };
      uiParser.on("data", (data) => handler(data));
      f.emit("session_start");
      for (const [packet, expected] of [
        [`${ESC}[Ox`, "focused"],
        [`x${ESC}[O`, "unfocused"],
        [`${ESC}[Ix${ESC}[O`, "unfocused"],
      ]) {
        if (piFirst) uiParser.process(packet);
        process.stdin.emit("data", packet);
        if (!piFirst) uiParser.process(packet);
        await f.command("notify", "check");
        expect(f.notices.at(-1)).toContain(`terminal-focus:${expected}`);
      }
      uiParser.destroy(); f.emit("session_shutdown");
    }
  });
  test("typing establishes focus before the first focus event", async () => {
    const f = setup(); f.emit("session_start"); f.input("hello");
    await f.command("notify", "check");
    expect(f.notices.at(-1)).toContain("terminal-input:focused");
    writes.length = 0;
    f.emit("agent_start"); await finish(f, "error");
    expect(writes).toEqual([]);
    process.stdin.emit("data", `${ESC}[O`);
    now += 4000;
    f.emit("agent_start"); await finish(f, "error");
    expect(writes.at(-1)).toContain("]777;notify;");
  });
  test("raw observation reassembles focus events and treats paste as focus, not embedded events", async () => {
    const f = setup(); f.emit("session_start");
    process.stdin.emit("data", `${ESC}[`);
    process.stdin.emit("data", "O");
    await f.command("notify", "check");
    expect(f.notices.at(-1)).toContain("terminal-focus:unfocused");
    process.stdin.emit("data", `${ESC}[200~literal${ESC}[`);
    process.stdin.emit("data", `I${ESC}[O${ESC}[201~`);
    await f.command("notify", "check");
    expect(f.notices.at(-1)).toContain("terminal-focus:focused");
    process.stdin.emit("data", Buffer.from(`${ESC}[I`));
    await f.command("notify", "check");
    expect(f.notices.at(-1)).toContain("terminal-focus:focused");
  });
  test("returning through raw FocusIn cancels a delayed alert", async () => {
    const f = setup(); f.emit("session_start");
    process.stdin.emit("data", `${ESC}[O`);
    f.emit("agent_start"); await finish(f, "error");
    expect(timers.size).toBe(1);
    const pending = [...timers.values()];
    process.stdin.emit("data", `${ESC}[I`);
    expect(timers.size).toBe(0);
    writes.length = 0;
    for (const callback of pending) callback();
    expect(writes).toEqual([]);
    expect(f.titles).toEqual([]);
  });
  test("raw observer is TUI-only and removed on shutdown and restart", () => {
    const before = process.stdin.listenerCount("data");
    const f = setup(); const headless = setup("rpc");
    headless.emit("session_start");
    expect(process.stdin.listenerCount("data")).toBe(before);
    f.emit("session_start"); f.emit("session_start");
    expect(process.stdin.listenerCount("data")).toBe(before + 1);
    f.emit("session_shutdown");
    expect(process.stdin.listenerCount("data")).toBe(before);
  });
  test("tmux visibility does not claim desktop focus", async () => {
    process.env.TMUX = "test";
    const f = setup();
    for (const [err, output, expected] of [[null, "0\n", "unfocused"], [null, "1\n", "?"], [null, "2\n", "?"], [null, "", "?"], [new Error("query failed"), "0\n", "?"]] as const) {
      const check = f.command("notify", "check"); commands.at(-1)!.callback(err, output); await check;
      expect(f.notices.at(-1)).toContain(`tmux:${expected}`);
    }
  });
  test("tmux fallback queries Pi's own pane, with implicit target only if absent", async () => {
    process.env.TMUX = "test";
    const f = setup();
    for (const pane of ["%123", undefined]) {
      if (pane) process.env.TMUX_PANE = pane; else delete process.env.TMUX_PANE;
      const check = f.command("notify", "check"); const cmd = commands.at(-1)!;
      expect(cmd.args).toEqual(["display-message", "-p", ...(pane ? ["-t", pane] : []), "#{window_active_clients}"]);
      cmd.callback(null, "0\n"); await check;
      expect(f.notices.at(-1)).toContain("tmux:unfocused");
    }
  });
  test("terminal replies do not imply focus or cancel alerts", async () => {
    const f = setup(); f.emit("session_start"); f.input(`${ESC}[O`);
    f.emit("agent_start"); f.emit("tool_execution_end", { isError: false }); await finish(f);
    for (const data of [`${ESC}[6;20;10t`, `${ESC}[4;800;600t`, `${ESC}[1;2R`, `${ESC}[?1;2c`, `${ESC}[0n`, `${ESC}]11;rgb:0000/0000/0000\x07`, `${ESC}P1+rdata${ESC}\\`]) {
      expect(f.input(data)).toBeUndefined();
    }
    await f.command("notify", "check");
    expect(f.notices.at(-1)).toContain("unfocused");
    expect(timers.size).toBe(1);
  });
  test("keyboard and pasted input still imply focus", async () => {
    for (const data of ["hello", `${ESC}P`, `${ESC}]`, `${ESC}[200~paste${ESC}[201~`]) {
      const f = setup(); away(f); f.input(data);
      for (const callback of [...timers.values()]) callback(); // Flush incomplete escape input.
      await f.command("notify", "check");
      expect(f.notices.at(-1)).toContain("terminal-focus:focused");
    }
  });
  test("notification title cannot inject OSC controls or fields", async () => {
    const f = setup("tui", "/tmp/bad\x1b]52;c;owned\x07;name"); away(f);
    f.emit("agent_start"); f.emit("tool_execution_end", { isError: false }); await finish(f);
    const seq = writes.find((w) => w.includes("]777;"))!;
    expect(seq.match(/\x1b/g)).toHaveLength(1);
    expect(seq.match(/\x07/g)).toHaveLength(1);
    expect(seq.split(";")).toHaveLength(4);
  });
  test("marked title cannot inject terminal controls", async () => {
    process.env.PI_PING_MARKER = "\x1b]52;c;owned\x07";
    const f = setup(); away(f); f.emit("agent_start"); f.emit("tool_execution_end", { isError: false }); await finish(f);
    expect(f.titles.at(-1)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });
  test("bracketed paste preserves literal focus sequences", () => {
    const state = initialFocusState();
    const data = `${ESC}[200~literal${ESC}[Otext${ESC}[I${ESC}[201~`;
    expect(scanFocusInput(data, state)).toBeUndefined();
    expect(state.gotFocusEvent).toBe(false);
  });
});

describe("configuration", () => {
  test("body and error templates substitute settled stats and formatted duration", async () => {
    process.env.PI_PING_BODY = "Completed in {duration}: {tools}/{errors} {status} {dir}";
    process.env.PI_PING_ERROR_BODY = "Failed after {duration}";
    process.env.PI_PING_TITLE = "{dir}: {status}";
    const f = setup(); away(f);
    f.emit("agent_start"); f.emit("tool_execution_end", { isError: true });
    now += 12_000; await finish(f);
    expect(writes.at(-1)).toBe(`${ESC}]777;notify;project: done;Completed in 12s: 1/1 done project\x07`);
    f.emit("agent_start"); now += 64_000; await finish(f, "error");
    expect(writes.at(-1)).toBe(`${ESC}]777;notify;project: error;Failed after 1m 04s\x07`);
  });
  test("body template covers fast errors, repeated tokens, and literal unknown tokens", async () => {
    process.env.PI_PING_BODY = "{status}/{status} {duration} {tools} {errors} {unknown} {dir}";
    const f = setup("tui", "/tmp/{status}"); away(f); f.emit("agent_start"); await finish(f, "error");
    expect(writes.at(-1)).toBe(`${ESC}]777;notify;Pi: {status};error/error 0s 0 0 {unknown} {status}\x07`);
  });
  test("session and final-response metadata use the error title only on final failure", async () => {
    process.env.PI_PING_TITLE = "{session}: {status}";
    process.env.PI_PING_ERROR_TITLE = "{session}: {stop_reason}";
    process.env.PI_PING_BODY = "{model}|{provider}|{thinking}|{cwd}|{duration_ms}|{stop_reason}|{error_message}";
    const f = setup(); f.ctx.sessionManager.getSessionName = () => "config";
    f.ctx.model = { id: "selected-model", provider: "selected-provider" };
    f.ctx.thinkingLevel = "low"; away(f); f.emit("agent_start");
    now += 1234;
    f.emit("agent_end", { messages: [{ role: "assistant", model: "response-model", provider: "response-provider",
      thinkingLevel: "high", stopReason: "error", errorMessage: "Quota reached" }] });
    await f.emit("agent_settled");
    expect(writes.at(-1)).toBe(`${ESC}]777;notify;config: error;response-model|response-provider|high|/tmp/project|1234|error|Quota reached\x07`);
    f.emit("agent_start"); f.emit("tool_execution_end", { isError: true });
    await finish(f);
    expect(writes.at(-1)).toBe(`${ESC}]777;notify;config: done;selected-model|selected-provider|low|/tmp/project|0|stop|\x07`);
  });
  test("missing optional metadata renders empty text and length stays distinct from error", async () => {
    process.env.PI_PING_BODY = "{session}|{model}|{provider}|{thinking}|{error_message}|{stop_reason}|{status}";
    const f = setup(); away(f); f.emit("agent_start"); now += 10_000; await finish(f, "length");
    expect(writes.at(-1)).toBe(`${ESC}]777;notify;Pi: project;|||||length|done\x07`);
  });
  test("usage includes retries and continuations without recounting agent_end messages", async () => {
    process.env.PI_PING_BODY = "{turns}|{input_tokens}|{output_tokens}|{cache_read_tokens}|{cache_write_tokens}|{tokens}|{cost}";
    const f = setup(); away(f); f.emit("agent_start");
    const first = { role: "assistant", stopReason: "error", usage: {
      input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19, cost: { total: 0.0123 },
    } };
    const second = { role: "assistant", stopReason: "stop", usage: {
      input: 20, output: 5, cacheRead: 6, cacheWrite: 7, totalTokens: 38, cost: { total: 0.0201 },
    } };
    f.emit("message_end", { message: { role: "user", content: "hello" } });
    f.emit("message_end", { message: first }); f.emit("agent_end", { messages: [first] });
    f.emit("agent_start"); f.emit("message_end", { message: second });
    f.emit("message_end", { message: { role: "toolResult", content: "ok" } });
    f.emit("agent_end", { messages: [first, second] }); now += 10_000; await f.emit("agent_settled");
    expect(writes.at(-1)).toBe(`${ESC}]777;notify;Pi: project;2|30|7|9|11|57|0.0324\x07`);
    f.emit("agent_start"); await finish(f, "error");
    expect(writes.at(-1)).toBe(`${ESC}]777;notify;Pi: project;0|0|0|0|0|0|0.0000\x07`);
  });
  test("usage is session-local and cleared on shutdown", async () => {
    process.env.PI_PING_BODY = "{turns}/{tokens}";
    const first = setup(); const second = setup(); away(first); away(second);
    first.emit("agent_start"); second.emit("agent_start");
    first.emit("message_end", { message: { role: "assistant", usage: { totalTokens: 42 } } });
    await finish(second, "error"); expect(writes.at(-1)).toContain(";0/0\x07");
    first.emit("session_shutdown"); away(first); first.emit("agent_start");
    await finish(first, "error"); expect(writes.at(-1)).toContain(";0/0\x07");
  });
  test("minimal defaults identify the session or directory and show only outcome and duration", async () => {
    for (const [cwd, session, reason, elapsed, title, body] of [
      ["/tmp/project", undefined, "stop", 12_000, "Pi: project", "Done in 12s"],
      ["/tmp/project", "fix config", "stop", 64_000, "Pi: fix config", "Done in 1m 04s"],
      ["/tmp/project", undefined, "error", 0, "Pi: project", "Stopped after 0s"],
      ["/tmp/project", "", "length", 64_000, "Pi: project", "Done in 1m 04s"],
      ["/", undefined, "stop", 500, "Pi", "Done in 1s"],
    ] as const) {
      const f = setup("tui", cwd); f.ctx.sessionManager.getSessionName = () => session;
      away(f); f.emit("agent_start");
      f.emit("tool_execution_end", { isError: true }); f.emit("tool_execution_end", { isError: false });
      now += elapsed; await finish(f, reason);
      expect(writes.at(-1)).toBe(`${ESC}]777;notify;${title};${body}\x07`);
    }
  });
  test("custom thresholds change eligibility and away delay", async () => {
    process.env.PI_PING_MIN_WORK_MS = "500";
    process.env.PI_PING_MIN_AWAY_MS = "6000";
    const f = setup(); f.emit("session_start"); f.input(`${ESC}[O`); writes.length = 0;
    f.emit("agent_start"); now += 499; await finish(f); expect(timers.size).toBe(0);
    f.emit("agent_start"); now += 500; await finish(f);
    expect(writes).toEqual([]);
    expect([...timers.keys()]).toMatchObject([{ delay: 5001 }]);
    now += 5001; for (const timer of timers.values()) timer();
    expect(writes.at(-1)).toContain("]777;notify;");
  });
  test("zero thresholds and an empty marker are supported", async () => {
    process.env.PI_PING_MIN_WORK_MS = "0"; process.env.PI_PING_MIN_AWAY_MS = "0";
    process.env.PI_PING_MARKER = "";
    const f = setup(); f.emit("session_start"); f.input(`${ESC}[O`); writes.length = 0;
    f.emit("agent_start"); await finish(f);
    expect(writes.at(-1)).toContain("]777;notify;"); expect(timers.size).toBe(0); expect(f.titles).toEqual([]);
    writes.length = 0; f.input(`${ESC}[I`); f.emit("agent_start"); await finish(f, "error");
    expect(writes).toEqual([]);
    f.input(`${ESC}[O`); f.emit("agent_start"); await finish(f, "aborted");
    expect(writes).toEqual([]);
  });
  test("invalid configuration fails with the variable name", () => {
    for (const [key, values] of [
      ["PI_PING_MIN_WORK_MS", ["", "-1", "NaN", "Infinity", "1.5", "2147483648"]],
      ["PI_PING_MIN_AWAY_MS", ["bad"]],
      ["PI_PING_PROTOCOL", ["", "osc42"]],
      ["PI_PING_DESKTOP_FALLBACK", ["", "yes"]],
    ] as const) {
      for (const value of values) {
        process.env[key] = value;
        expect(() => setup()).toThrow(key);
        delete process.env[key];
      }
    }
  });
  test("protocol override and fallback toggle apply to test delivery", async () => {
    process.env.TERM_PROGRAM = "ghostty"; process.env.KITTY_WINDOW_ID = "1";
    process.env.PI_PING_DESKTOP_FALLBACK = "false";
    const title = "Pi (project) (test)";
    const body = "Desktop and terminal notifications are working.";
    for (const [protocol, expected] of [
      ["auto", `${ESC}]99;i=100000:d=0;${title}${ESC}\\${ESC}]99;i=100000:p=body;${body}${ESC}\\`],
      ["osc9", `${ESC}]9;${title}: ${body}\x07`],
      ["osc99", `${ESC}]99;i=100000:d=0;${title}${ESC}\\${ESC}]99;i=100000:p=body;${body}${ESC}\\`],
      ["osc777", `${ESC}]777;notify;${title};${body}\x07`],
    ]) {
      process.env.PI_PING_PROTOCOL = protocol;
      const f = setup(); await f.command("notify", "test");
      expect(writes.at(-1)).toBe(expected); expect(commands).toEqual([]);
    }
  });
  test("duration rounds across minute boundaries and empty templates stay empty", async () => {
    process.env.PI_PING_BODY = "{duration}";
    for (const [elapsed, expected] of [[499, "0s"], [500, "1s"], [59_499, "59s"], [59_500, "1m 00s"], [3_600_000, "60m 00s"]] as const) {
      const f = setup(); away(f); f.emit("agent_start"); now += elapsed; await finish(f, "error");
      expect(writes.at(-1)).toBe(`${ESC}]777;notify;Pi: project;${expected}\x07`);
    }
    process.env.PI_PING_TITLE = ""; process.env.PI_PING_ERROR_BODY = "";
    const f = setup(); away(f); f.emit("agent_start"); await finish(f, "error");
    expect(writes.at(-1)).toBe(`${ESC}]777;notify;;\x07`);
  });
  test("templates are sanitized on terminal and desktop delivery", async () => {
    process.env.PI_PING_BODY = "{error_message}";
    process.env.PI_PING_TITLE = "{session}";
    for (const [rawTitle, rawBody, title, body, terminal] of [
      ["title\x07;field", "done\x1b]52;c;owned\x07;body", "title;field", "done]52;c;owned;body", "title,field;done]52,c,owned,body"],
      ["--help", "normal", "--help", "normal", "--help;normal"],
      ["normal", "--help", "normal", "--help", "normal;--help"],
    ]) {
      const f = setup(); f.ctx.sessionManager.getSessionName = () => rawTitle;
      away(f); f.emit("agent_start");
      f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: rawBody }] });
      await f.emit("agent_settled");
      expect(writes.at(-1)).toBe(`${ESC}]777;notify;${terminal}\x07`);
      if (process.platform === "linux") {
        expect(commands.at(-1)?.args).toEqual(["-a", "Pi", "--", title, body]);
      }
    }
  });
});

describe("lifecycle", () => {
  test("only the last TUI owner disables terminal focus reporting", () => {
    const first = setup(); const second = setup(); first.emit("session_start"); second.emit("session_start");
    writes.length = 0; first.emit("session_shutdown"); expect(writes).toEqual([]);
    second.emit("session_shutdown"); expect(writes).toEqual([`${ESC}[?1004l`]);
  });
  test("session restart resets unfinished run statistics", async () => {
    const f = setup(); away(f); f.emit("agent_start"); f.emit("tool_execution_end", { isError: false });
    f.emit("session_shutdown"); away(f); f.emit("agent_start"); await finish(f);
    expect(writes).toEqual([]);
  });
  test("shutdown cancels delayed notifications and unsubscribes", async () => {
    const f = setup(); f.emit("session_start"); f.input(`${ESC}[O`);
    f.emit("agent_start"); f.emit("tool_execution_end", { isError: false }); await finish(f);
    expect(timers.size).toBe(1); f.emit("session_shutdown"); writes.length = 0;
    for (const timer of timers.values()) timer();
    expect(writes).toEqual([]); expect(f.unsubscribed()).toBe(1);
  });
  test("inactive factories and headless sessions acquire no exit hooks", () => {
    const before = process.listenerCount("exit");
    setup(); const headless = setup("rpc"); headless.emit("session_start");
    expect(process.listenerCount("exit")).toBe(before);
  });
  test("session restart retains exit cleanup and releases its hook", () => {
    const before = new Set(process.listeners("exit"));
    const f = setup(); f.emit("session_start"); f.emit("session_shutdown"); f.emit("session_start");
    const hook = process.listeners("exit").find((fn) => !before.has(fn))!;
    expect(hook).toBeDefined(); writes.length = 0; hook(0);
    expect(writes).toContain(`${ESC}[?1004l`);
    expect(process.listenerCount("exit")).toBe(before.size);
  });
  test("multiple sessions share a hook and headless shutdown leaves focus active", () => {
    const before = process.listenerCount("exit");
    const first = setup(); const second = setup(); const headless = setup("rpc");
    first.emit("session_start"); second.emit("session_start"); headless.emit("session_start");
    expect(process.listenerCount("exit")).toBe(before + 1);
    writes.length = 0; headless.emit("session_shutdown"); expect(writes).toEqual([]);
    first.emit("session_shutdown"); expect(process.listenerCount("exit")).toBe(before + 1);
    second.emit("session_shutdown"); expect(process.listenerCount("exit")).toBe(before);
  });
});
