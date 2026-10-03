import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const writes: string[] = [];
const commands: { name: string; args: string[]; callback: Function }[] = [];
mock.module("node:fs", () => ({ appendFileSync: (_path: string, data: string) => writes.push(data) }));
mock.module("node:child_process", () => ({ execFile: (name: string, args: string[], _options: unknown, callback: Function) => {
  commands.push({ name, args, callback });
  if (name !== "tmux") callback(null, "");
} }));
const env = { ...process.env };
process.env.PI_PING_MARKER = "\x1b]52;c;owned\x07";
const { default: extension, initialFocusState, scanFocusInput } = await import("./index.ts");
process.env = { ...env };
const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let now = 100_000;
let timers: Map<object, () => void>;
const ESC = "\x1b";
let fixtures: ReturnType<typeof setup>[] = [];
function setup(mode = "tui", cwd = "/tmp/project") {
  const handlers = new Map<string, Function>();
  const registeredCommands = new Map<string, { handler: Function }>();
  const titles: string[] = [];
  const notices: string[] = [];
  let input: Function | undefined;
  let unsubscribed = 0;
  const ctx = { mode, cwd, sessionManager: { getSessionName: () => undefined }, ui: {
    onTerminalInput: (fn: Function) => { input = fn; return () => { input = undefined; unsubscribed++; }; },
    setTitle: (title: string) => titles.push(title), notify: (text: string) => notices.push(text),
  } };
  extension({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (name: string, cmd: any) => registeredCommands.set(name, cmd) } as any);
  const fixture = { ctx, titles, notices,
    emit: (name: string, event: any = {}) => handlers.get(name)?.(event, ctx),
    input: (data: string) => input?.(data),
    command: (name: string) => registeredCommands.get(name)!.handler("", ctx),
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
  for (const key of ["TMUX", "TMUX_PANE", "KITTY_WINDOW_ID", "TERM_PROGRAM", "PI_PING_MARKER"]) delete process.env[key];
  writes.length = 0; commands.length = 0; now = 100_000; timers = new Map();
  Date.now = () => now;
  globalThis.setTimeout = ((fn: () => void) => { const timer = { unref() {} }; timers.set(timer, fn); return timer; }) as any;
  globalThis.clearTimeout = ((timer: object) => { timers.delete(timer); }) as any;
});
afterEach(() => {
  for (const f of fixtures) f.emit("session_shutdown");
  fixtures = [];
  Date.now = realNow; globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
  process.env = { ...env };
});

describe("run contracts", () => {
  test("notify-check keeps settled duration and uses notification eligibility", async () => {
    const f = setup(); away(f); f.emit("agent_start"); await finish(f);
    now += 60_000; await f.command("notify-check");
    expect(f.notices.at(-1)).toContain("dur=0s | would silent");
    f.emit("agent_start"); f.emit("tool_execution_end", { isError: true }); await finish(f, "aborted");
    await f.command("notify-check"); expect(f.notices.at(-1)).toEndWith("would silent");
    f.emit("agent_start"); await finish(f, "error"); await f.command("notify-check");
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
    const f = setup(); away(f); f.emit("agent_start"); f.emit("tool_execution_end", { isError: false });
    f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
    now += 1000; f.emit("agent_start"); f.emit("tool_execution_end", { isError: false }); await finish(f);
    expect(writes.filter((w) => w.includes("]777;"))).toHaveLength(1);
    expect(writes.join("")).toContain("2 tool calls");
  });
});

describe("terminal boundaries", () => {
  test("tmux visibility does not claim desktop focus", async () => {
    process.env.TMUX = "test";
    const f = setup();
    for (const [err, output, expected] of [[null, "0\n", "unfocused"], [null, "1\n", "?"], [null, "2\n", "?"], [null, "", "?"], [new Error("query failed"), "0\n", "?"]] as const) {
      const check = f.command("notify-check"); commands.at(-1)!.callback(err, output); await check;
      expect(f.notices.at(-1)).toContain(`tmux:${expected}`);
    }
  });
  test("tmux fallback queries Pi's own pane, with implicit target only if absent", async () => {
    process.env.TMUX = "test";
    const f = setup();
    for (const pane of ["%123", undefined]) {
      if (pane) process.env.TMUX_PANE = pane; else delete process.env.TMUX_PANE;
      const check = f.command("notify-check"); const cmd = commands.at(-1)!;
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
    await f.command("notify-check");
    expect(f.notices.at(-1)).toContain("unfocused");
    expect(timers.size).toBe(1);
  });
  test("keyboard and pasted input still imply focus", async () => {
    for (const data of ["hello", `${ESC}P`, `${ESC}]`, `${ESC}[200~paste${ESC}[201~`]) {
      const f = setup(); away(f); f.input(data); await f.command("notify-check");
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
