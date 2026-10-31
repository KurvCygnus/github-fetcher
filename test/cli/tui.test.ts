import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { selectFromMenu } from "../../src/cli/tui.js";

function fakeStdin(keys: string[]) {
  const stdin = new EventEmitter() as EventEmitter & { isTTY: boolean; setRawMode: (mode: boolean) => void };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
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
});
