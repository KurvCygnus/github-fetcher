import { describe, expect, it, vi } from "vitest";
import { BatchTimeoutError, mapWithConcurrency, withTimeout } from "../../src/core/batch.js";

describe("mapWithConcurrency", () => {
  it("caps in-flight workers at the limit and returns results in input order", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item, index) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await Promise.resolve();
        return item * 10 + index;
      } finally {
        active -= 1;
      }
    });
    expect(peak).toBe(2);
    expect(result).toEqual([10, 21, 32, 43, 54]);
  });

  it("keeps input order when workers settle out of order", async () => {
    const release: Array<() => void> = [];
    const started: number[] = [];
    const pending = mapWithConcurrency([1, 2, 3], 3, (item) => new Promise<number>((resolve) => {
      started.push(item);
      release.push(() => resolve(item * 10));
    }));
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    //* Release in reverse: result slots must stay keyed by input index, not by
    //* the order in which workers happen to finish.
    release[2]?.();
    release[0]?.();
    release[1]?.();
    await expect(pending).resolves.toEqual([10, 20, 30]);
  });

  it("propagates the first worker rejection", async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("boom");
      await Promise.resolve();
      return item;
    })).rejects.toThrow("boom");
  });

  it("resolves to an empty array for no items", async () => {
    await expect(mapWithConcurrency([], 2, async (item) => item)).resolves.toEqual([]);
  });

  it("treats a fractional limit below one as a single-worker pool", async () => {
    //* Flooring a positive fraction yields zero, which would leave the pool
    //* with no launchable worker and the returned promise permanently pending.
    await expect(mapWithConcurrency([1], 0.5, async (item) => item * 10)).resolves.toEqual([10]);
  });
});

describe("withTimeout", () => {
  it("resolves with the underlying value", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "x")).resolves.toBe("ok");
  });

  it("rejects with a BatchTimeoutError carrying the timeout code and exact message", async () => {
    vi.useFakeTimers();
    try {
      //* The underlying promise never settles, so a rejection can only come from
      //* the external timer; advancing 1000 ms must trigger exactly one timeout.
      const pending = withTimeout(new Promise<string>(() => {}), 1000, "slow");
      const codeAndMessage = expect(pending).rejects.toMatchObject({
        code: "timeout",
        message: "Timed out after 1000ms: slow",
      });
      const errorType = expect(pending).rejects.toBeInstanceOf(BatchTimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await codeAndMessage;
      await errorType;
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates the underlying rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("down")), 1000, "x")).rejects.toThrow("down");
  });
});
