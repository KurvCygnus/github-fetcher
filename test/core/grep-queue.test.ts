import { describe, expect, it } from "vitest";
import { grepConcurrency, setGrepConcurrency, withGrepSlot } from "../../src/core/grep-queue.js";

//? The queue is process-global module state, so every test sets the capacity it
//* needs and restores the 4-slot default on exit to keep the cases independent.
describe("grep queue", () => {
  it("caps active grep jobs at the configured concurrency", async () => {
    setGrepConcurrency(2);
    let active = 0;
    let peak = 0;
    const jobs = Array.from({ length: 5 }, () => withGrepSlot(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    }));
    await Promise.all(jobs);
    expect(peak).toBe(2);
    setGrepConcurrency(4);
  });

  it("runs a sole job immediately and reports the configured capacity", async () => {
    setGrepConcurrency(3);
    expect(grepConcurrency()).toBe(3);
    await expect(withGrepSlot(async () => "ok")).resolves.toBe("ok");
    setGrepConcurrency(4);
  });

  it("frees the slot when the wrapped job rejects", async () => {
    setGrepConcurrency(1);
    await expect(withGrepSlot(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    //* A second job must acquire the slot the rejected one released, otherwise
    //* the queue would deadlock after any worker failure.
    await expect(withGrepSlot(async () => "next")).resolves.toBe("next");
    setGrepConcurrency(4);
  });

  it("serves queued callers in FIFO order", async () => {
    setGrepConcurrency(1);
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = withGrepSlot(async () => {
      order.push("first");
      markStarted();
      await gate;
    });
    const second = withGrepSlot(async () => {
      order.push("second");
    });
    const third = withGrepSlot(async () => {
      order.push("third");
    });
    await started;
    expect(order).toEqual(["first"]);
    releaseFirst();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second", "third"]);
    setGrepConcurrency(4);
  });

  it("ignores a capacity change while jobs are in flight", async () => {
    setGrepConcurrency(1);
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withGrepSlot(async () => {
      await gate;
    });
    //* The first job acquires its slot synchronously inside acquire(), so the
    //* queue is already busy when the reconfigure attempt lands.
    setGrepConcurrency(3);
    expect(grepConcurrency()).toBe(1);
    releaseFirst();
    await first;
    setGrepConcurrency(4);
  });
});
