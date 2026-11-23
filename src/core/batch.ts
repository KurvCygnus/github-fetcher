export class BatchTimeoutError extends Error {
  readonly code = "timeout" as const;

  constructor(message: string) {
    super(message);
    this.name = "BatchTimeoutError";
  }
}

export function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return new Promise<R[]>((resolve, reject) => {
    const results = new Array<R>(items.length);
    //* Flooring a limit in (0,1) would produce zero workers and a pool that
    //* never settles, so every non-finite or sub-one limit falls back to one.
    const ceiling = Number.isFinite(limit) && limit >= 1 ? Math.max(1, Math.floor(limit)) : 1;
    //* Iterating entries keeps the index/item pair total under
    //* noUncheckedIndexedAccess; each item is consumed exactly once.
    const remaining = items.entries();
    let active = 0;
    let settled = 0;
    let stopped = false;

    const finish = (): void => {
      if (settled === items.length) resolve(results);
    };

    const launch = (): void => {
      if (stopped) return;
      while (active < ceiling) {
        const next = remaining.next();
        if (next.done === true) break;
        const [index, item] = next.value;
        active += 1;
        //* Routing through a resolved promise turns a synchronous worker throw
        //* into a rejection, so one bad item cannot escape the pool.
        void Promise.resolve()
          .then(() => worker(item, index))
          .then(
            (value: R) => {
              results[index] = value;
              active -= 1;
              settled += 1;
              finish();
              launch();
            },
            (error: unknown) => {
              stopped = true;
              reject(error);
            },
          );
      }
      finish();
    };

    launch();
  });
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      //* The underlying promise is abandoned with no cancellation signal, and
      //* its eventual result is discarded by the race.
      reject(new BatchTimeoutError(`Timed out after ${ms}ms: ${label}`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
