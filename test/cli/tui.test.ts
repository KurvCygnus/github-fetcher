import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { selectFromMenu } from "../../src/cli/tui.js";

function fakeStdin(keys: string[]) {
  const rawModes: boolean[] = [];
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    rawModes: boolean[];
  };
  stdin.isTTY = true;
  stdin.setRawMode = (mode) => {
    rawModes.push(mode);
  };
  stdin.rawModes = rawModes;
  const feed = () => {
    const key = keys.shift();
    if (key === undefined) return;
    const name = key === " " ? "space" : key === "\r" ? "return" : key === "\x1b" ? "escape" : key;
    stdin.emit("keypress", name, { name });
  };
  // feed the next key on each render so the state machine is exercised in order
  return Object.assign(stdin, {
    feedNext: () => process.nextTick(feed),
    feedAll: () => {
      while (keys.length > 0) feed();
    },
  });
}

function capture() {
  const chunks: string[] = [];
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      },
    } as NodeJS.WritableStream,
    text: () => chunks.join(""),
  };
}

function fakeTtyStream() {
  const stream = new PassThrough();
  const rawModes: boolean[] = [];
  Object.assign(stream, {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      rawModes.push(mode);
    },
  });
  return { stream, rawModes };
}

describe("selectFromMenu", () => {
  const items = [
    { id: "opencode", label: "OpenCode", note: "detected" },
    { id: "cursor", label: "Cursor", note: "not detected, will create" },
  ];

  it("toggles, confirms, and returns the selection", async () => {
    const stdin = fakeStdin([" ", "down", " ", "\r"]);
    const out = capture();
    const feed = (stdin as unknown as { feedAll: () => void }).feedAll;
    const promise = selectFromMenu(items, { input: stdin as unknown as NodeJS.ReadStream, output: out.stdout }, []);
    feed();
    const result = await promise;
    expect(result).toEqual(["opencode", "cursor"]);
  });

  it("returns null on escape", async () => {
    const stdin = fakeStdin(["\x1b"]);
    const out = capture();
    const promise = selectFromMenu(
      items,
      { input: stdin as unknown as NodeJS.ReadStream, output: out.stdout },
      ["opencode"],
    );
    (stdin as unknown as { feedNext: () => void }).feedNext();
    const result = await promise;
    expect(result).toBeNull();
  });

  it("renders preselection and notes", async () => {
    const stdin = fakeStdin(["\r"]);
    const out = capture();
    const promise = selectFromMenu(
      items,
      { input: stdin as unknown as NodeJS.ReadStream, output: out.stdout },
      ["opencode"],
    );
    (stdin as unknown as { feedNext: () => void }).feedNext();
    await promise;
    expect(out.text()).toContain("[x] OpenCode");
    expect(out.text()).toContain("[ ] Cursor");
    expect(out.text()).toContain("not detected, will create");
  });

  it("removes keypress and data listeners, restores flow, and restores raw mode after confirm and cancel", async () => {
    const keys = [
      ["\r", "return"],
      ["\x1b", "escape"],
    ] as const;
    for (const [key, name] of keys) {
      const { stream, rawModes } = fakeTtyStream();
      const out = capture();
      expect(stream.readableFlowing).not.toBe(true);
      const promise = selectFromMenu(items, { input: stream as unknown as NodeJS.ReadStream, output: out.stdout }, []);
      stream.emit("keypress", key, { name });
      await promise;
      expect(stream.listenerCount("keypress")).toBe(0);
      expect(stream.listenerCount("data")).toBe(0);
      expect(stream.listenerCount("end")).toBe(0);
      expect(stream.listenerCount("close")).toBe(0);
      expect(stream.listenerCount("error")).toBe(0);
      expect(stream.readableFlowing).not.toBe(true);
      expect(rawModes).toEqual([true, false]);
    }
  });

  it("resolves null and restores raw mode when stdin ends", async () => {
    const stdin = fakeStdin([]);
    const out = capture();
    const promise = selectFromMenu(items, { input: stdin as unknown as NodeJS.ReadStream, output: out.stdout }, []);
    stdin.emit("end");
    await expect(promise).resolves.toBeNull();
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.listenerCount("keypress")).toBe(0);
    expect(stdin.listenerCount("end")).toBe(0);
    expect(stdin.listenerCount("close")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);
  });

  it("settles null and cleans up when the initial or a rerender write throws", async () => {
    for (const throwAt of [0, 1]) {
      const stdin = fakeStdin([]);
      let writes = 0;
      const output = {
        write: () => {
          if (writes === throwAt) throw new Error("broken pipe");
          writes += 1;
          return true;
        },
      } as unknown as NodeJS.WritableStream;
      const promise = selectFromMenu(items, { input: stdin as unknown as NodeJS.ReadStream, output }, []);
      if (throwAt === 1) stdin.emit("keypress", "down", { name: "down" });
      await expect(promise).resolves.toBeNull();
      expect(writes).toBe(throwAt);
      expect(stdin.rawModes).toEqual([true, false]);
      expect(stdin.listenerCount("keypress")).toBe(0);
      expect(stdin.listenerCount("data")).toBe(0);
    }
  });
});
