import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const CANCEL = Symbol("clack-cancel");
  const spinnerHandle = {
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    clear: vi.fn(),
  };
  return {
    CANCEL,
    spinnerHandle,
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    multiselect: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    spinner: vi.fn(),
    cancel: vi.fn(),
    isCancel: vi.fn((value: unknown) => value === CANCEL),
  };
});

vi.mock("@clack/prompts", () => ({
  CANCEL_SYMBOL: state.CANCEL,
  isCancel: state.isCancel,
  intro: state.intro,
  outro: state.outro,
  note: state.note,
  multiselect: state.multiselect,
  select: state.select,
  confirm: state.confirm,
  spinner: state.spinner,
  cancel: state.cancel,
}));

import { createClackAdapter } from "../../src/cli/prompts.js";

interface FakeOutput {
  write(chunk: string | Uint8Array): boolean;
  toString(): string;
}

function fakeOutput(): FakeOutput {
  let text = "";
  return {
    write(chunk: string | Uint8Array): boolean {
      text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    toString(): string {
      return text;
    },
  };
}

function opts(output: FakeOutput, input: NodeJS.ReadStream): { output: FakeOutput; input: NodeJS.ReadStream } {
  return { output, input };
}

describe("createClackAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.intro.mockImplementation((message: string, options: { output: FakeOutput }) => {
      options.output.write(`intro: ${message}\n`);
    });
    state.outro.mockImplementation((message: string, options: { output: FakeOutput }) => {
      options.output.write(`outro: ${message}\n`);
    });
    state.note.mockImplementation((message: string, title: string | undefined, options: { output: FakeOutput }) => {
      options.output.write(`note: ${title ?? ""}: ${message}\n`);
    });
    state.multiselect.mockResolvedValue(["a"]);
    state.select.mockResolvedValue("stdio");
    state.confirm.mockResolvedValue(true);
    state.spinner.mockReturnValue(state.spinnerHandle);
  });

  it("routes intro, note and outro text to the injected output and forwards both streams", () => {
    const output = fakeOutput();
    const input = {} as NodeJS.ReadStream;
    const adapter = createClackAdapter(output as unknown as NodeJS.WritableStream, input);

    adapter.intro("github-fetcher init");
    adapter.note("config paths", "config paths");
    adapter.outro("done");

    expect(output.toString()).toContain("github-fetcher init");
    expect(output.toString()).toContain("done");
    expect(state.intro).toHaveBeenCalledWith("github-fetcher init", opts(output, input));
    expect(state.note).toHaveBeenCalledWith("config paths", "config paths", opts(output, input));
    expect(state.outro).toHaveBeenCalledWith("done", opts(output, input));
  });

  it("converts a clack cancel sentinel to null for multiselect, select and confirm", async () => {
    const output = fakeOutput();
    const input = {} as NodeJS.ReadStream;
    const adapter = createClackAdapter(output as unknown as NodeJS.WritableStream, input);
    state.multiselect.mockResolvedValueOnce(state.CANCEL);
    state.select.mockResolvedValueOnce(state.CANCEL);
    state.confirm.mockResolvedValueOnce(state.CANCEL);

    await expect(
      adapter.multiselect({ message: "clients", options: [{ value: "opencode", label: "OpenCode" }] }),
    ).resolves.toBeNull();
    await expect(
      adapter.select({ message: "transport", options: [{ value: "stdio", label: "Stdio" }] }),
    ).resolves.toBeNull();
    await expect(adapter.confirm({ message: "proceed?" })).resolves.toBeNull();

    expect(state.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ message: "clients", output, input }),
    );
    expect(state.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "transport", output, input }),
    );
    expect(state.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "proceed?", output, input }),
    );
  });

  it("forwards values and option metadata without a cancel sentinel", async () => {
    const adapter = createClackAdapter(fakeOutput() as unknown as NodeJS.WritableStream);
    state.multiselect.mockResolvedValueOnce(["opencode", "cursor"]);
    state.select.mockResolvedValueOnce("http");
    state.confirm.mockResolvedValueOnce(false);

    await expect(
      adapter.multiselect({
        message: "clients",
        options: [{ value: "opencode", label: "OpenCode", hint: "(detected)" }],
        initialValues: ["opencode"],
      }),
    ).resolves.toEqual(["opencode", "cursor"]);
    await expect(
      adapter.select({
        message: "transport",
        options: [{ value: "stdio", label: "Stdio", hint: "recommended" }],
        initialValue: "stdio",
      }),
    ).resolves.toBe("http");
    await expect(adapter.confirm({ message: "proceed?", initialValue: true })).resolves.toBe(false);
  });

  it("runs the spinner work and returns its awaited value", async () => {
    const adapter = createClackAdapter(fakeOutput() as unknown as NodeJS.WritableStream);
    const work = vi.fn(async () => 42);

    await expect(adapter.spinner("writing config", work)).resolves.toBe(42);

    expect(work).toHaveBeenCalledOnce();
    expect(state.spinner).toHaveBeenCalledWith(expect.objectContaining({ output: expect.anything() }));
    expect(state.spinnerHandle.start).toHaveBeenCalledWith("writing config");
    expect(state.spinnerHandle.stop).toHaveBeenCalled();
  });
});
