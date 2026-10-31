import { emitKeypressEvents } from "node:readline";

export interface TuiItem {
  id: string;
  label: string;
  note?: string | undefined;
}

export interface TuiDeps {
  input: NodeJS.ReadStream;
  output: NodeJS.WritableStream;
}

export interface TuiState {
  cursor: number;
  selected: ReadonlySet<string>;
}

export type TuiAction = "up" | "down" | "toggle" | "toggle-all" | "confirm" | "cancel";

export interface TuiTransition {
  state: TuiState;
  done: "confirm" | "cancel" | null;
}

const HEADER = "Space to toggle, Enter to confirm, Esc to cancel";

export function actionForKey(name: string): TuiAction | null {
  switch (name) {
    case "up":
    case "k":
      return "up";
    case "down":
    case "j":
      return "down";
    case "space":
      return "toggle";
    case "a":
      return "toggle-all";
    case "return":
    case "enter":
      return "confirm";
    case "escape":
    case "q":
      return "cancel";
    default:
      return null;
  }
}

export function renderMenu(items: readonly TuiItem[], state: TuiState): string {
  const lines = ["\x1b[2J\x1b[H", HEADER];
  items.forEach((item, index) => {
    const pointer = index === state.cursor ? "> " : "  ";
    const mark = state.selected.has(item.id) ? "x" : " ";
    const note = item.note !== undefined && item.note !== "" ? ` (${item.note})` : "";
    lines.push(`${pointer}[${mark}] ${item.label}${note}`);
  });
  return lines.join("\n") + "\n";
}

export function applyMenuKey(items: readonly TuiItem[], state: TuiState, action: TuiAction): TuiTransition {
  if (action === "confirm" || action === "cancel") {
    return { state, done: action };
  }
  if (action === "toggle" || action === "toggle-all") {
    const selected = new Set(state.selected);
    if (action === "toggle-all") {
      const everySelected = items.every((item) => selected.has(item.id));
      for (const item of items) {
        if (everySelected) selected.delete(item.id);
        else selected.add(item.id);
      }
    } else {
      const current = items[state.cursor];
      if (current !== undefined) {
        if (selected.has(current.id)) selected.delete(current.id);
        else selected.add(current.id);
      }
    }
    return { state: { cursor: state.cursor, selected }, done: null };
  }
  if (items.length === 0) {
    return { state, done: null };
  }
  const delta = action === "up" ? -1 : 1;
  const cursor = (state.cursor + delta + items.length) % items.length;
  return { state: { cursor, selected: state.selected }, done: null };
}

export async function selectFromMenu(
  items: readonly TuiItem[],
  deps: TuiDeps,
  preselected: readonly string[] = [],
): Promise<string[] | null> {
  const { input, output } = deps;
  //? Raw mode is a terminal concern only; a piped stdin must never be switched or restored.
  const rawMode = input.isTTY === true && typeof input.setRawMode === "function";
  let state: TuiState = { cursor: 0, selected: new Set(preselected) };

  return await new Promise<string[] | null>((resolve) => {
    //* readline attaches its own data listener (which makes the stream flow) and resumes
    //* stdin; both belong to us to undo, or the process stays alive after the menu closes.
    const baselineDataListeners = new Set(input.listeners("data"));
    const wasFlowing = input.readableFlowing === true;
    let settled = false;

    function cleanup(): void {
      input.removeListener("keypress", onKeypress);
      for (const listener of input.listeners("data")) {
        if (!baselineDataListeners.has(listener)) input.removeListener("data", listener);
      }
      if (!wasFlowing && typeof input.pause === "function") input.pause();
      input.removeListener("end", onAbort);
      input.removeListener("close", onAbort);
      input.removeListener("error", onAbort);
      if (rawMode) input.setRawMode(false);
    }

    function finish(result: string[] | null): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function render(): void {
      try {
        output.write(renderMenu(items, state));
      } catch {
        //* A dead output must not strand the caller in raw mode; treat it like a cancel.
        finish(null);
      }
    }

    function onAbort(): void {
      finish(null);
    }

    function onKeypress(_chunk: string, key?: { name?: string | undefined } | undefined): void {
      if (settled) return;
      const action = actionForKey(key?.name ?? "");
      if (action === null) return;
      const transition = applyMenuKey(items, state, action);
      state = transition.state;
      if (transition.done === "confirm") {
        //* Item order, not click order, keeps the confirmed list stable for callers.
        finish(items.filter((item) => state.selected.has(item.id)).map((item) => item.id));
        return;
      }
      if (transition.done === "cancel") {
        finish(null);
        return;
      }
      render();
    }

    emitKeypressEvents(input);
    if (rawMode) input.setRawMode(true);
    input.on("keypress", onKeypress);
    input.once("end", onAbort);
    input.once("close", onAbort);
    input.once("error", onAbort);
    render();
  });
}
