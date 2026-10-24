import type { Database } from "better-sqlite3";
import { reserveQuoteCall } from "./store";

export class QuotaError extends Error {}
export class QueryCancelled extends Error {}
export type QueueOptions = {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  eligible?: () => string | null;
  onWait?: (until: number, reason: string) => void;
  maxWaitMs?: number;
};
// Each database connection shares a FIFO. SQLite's immediate reservation also
// guards against multiple connections/processes consuming the same credit.
const tails = new WeakMap<Database, Promise<void>>();
export async function withQuoteQuota<T>(db: Database, request: () => Promise<T>, options: QueueOptions = {}): Promise<T> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now().getTime() + (options.maxWaitMs ?? 15 * 60_000);
  const previous = tails.get(db) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  tails.set(db, previous.then(() => turn));
  try {
    // A queued task cannot wait forever behind an unavailable network request.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([previous, new Promise<never>((_, reject) => {
        timer=setTimeout(()=>reject(new QuotaError("行情排队超时，请稍后重试")),Math.max(1,deadline-now().getTime()));
      })]);
    } finally { if(timer) clearTimeout(timer); }
    for (let attempt = 0; attempt < 2; attempt++) {
      for (;;) {
        const cancelled = options.eligible?.();
        if (cancelled) throw new QueryCancelled(cancelled);
        if (now().getTime() >= deadline) throw new QuotaError("行情排队超过15分钟，请稍后重试");
        const reservation = reserveQuoteCall(db, now());
        if (reservation.ok) break;
        if (reservation.error !== "__wait__") throw new QuotaError(reservation.error);
        options.onWait?.(now().getTime() + reservation.retryAfterMs, "等待行情额度");
        // Recheck eligibility periodically, rather than sleeping through an ended window.
        await sleep(Math.min(reservation.retryAfterMs, 5000, deadline-now().getTime()));
      }
      options.onWait?.(0, "");
      try { return await request(); }
      catch (error) {
        // Structural check avoids quote -> quota -> quote circular imports.
        if (!(error instanceof Error) || error.name !== "RateLimitError") throw error;
        const after = Number((error as Error & {afterMs:number}).afterMs);
        const delay = Number.isFinite(after) && after > 0 ? Math.max(1000, after) : 61000;
        const until = now().getTime() + delay;
        db.prepare(`UPDATE quota_state SET cooldown_until=MAX(cooldown_until,?) WHERE id=1`).run(until);
        if (attempt === 1) throw error;
      }
    }
    throw new QuotaError("行情重试次数已用尽");
  } finally { release(); }
}
