const DEFAULT_CONCURRENCY = 4;

function initialConcurrency(): number {
  //* Daemon deployments host many sessions in one process, so the grep worker
  //* ceiling is read once at module load. Invalid values fall back to the
  //* documented default instead of stalling every queued caller at zero.
  const raw = process.env.GITHUB_MCP_DAEMON_GREP_CONCURRENCY;
  if (raw === undefined || raw === "") return DEFAULT_CONCURRENCY;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CONCURRENCY;
}

let concurrency = initialConcurrency();
let active = 0;
//* Waiters are the resolve half of their acquire promise; FIFO order is the
//* fairness contract so a burst of greps cannot let later callers barge ahead.
const waiters: Array<() => void> = [];

export function grepConcurrency(): number {
  return concurrency;
}

export function setGrepConcurrency(n: number): void {
  //* Reconfiguring while jobs hold or await slots would strand queued waiters
  //* or invalidate the active count, so capacity changes apply only when idle.
  if (active !== 0 || waiters.length !== 0) return;
  concurrency = n;
}

function acquire(): Promise<void> {
  return new Promise<void>((resolve) => {
    const grant = (): void => resolve();
    if (active < concurrency && waiters.length === 0) {
      active += 1;
      grant();
    } else {
      waiters.push(grant);
    }
  });
}

function release(): void {
  const next = waiters.shift();
  if (next === undefined) {
    active -= 1;
    return;
  }
  //* Hand the held slot straight to the next waiter; active stays put because
  //* ownership transfers without a fresh acquire.
  next();
}

export async function withGrepSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
