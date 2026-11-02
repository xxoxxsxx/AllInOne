// 提醒事项调度判定（纯函数、无 IO）：给定调度行与当前时间，判定本轮到期的推送
// 与应持久化的行更新。供 Server Actions（立即测试预演）与调度器（run.ts）共用。
//
// 三类调度在一条提醒上可并存，语义如下：
//   once    单次：at 到点且未处理 → 推送一次。离线补发：错过 ≤60s 正常推送；
//           错过 >60s 且 ≤ graceMs（默认 24h）→ 立即补发（catchup，标题加「[补发]」）；
//           超过 graceMs → 标记已错过（不推送，写一条 missed 日志）。
//   interval 间隔：start_at 起每 interval_seconds 一个槽位，共 total 次；sent 计已推送次数，
//           next_at 是「下一个待处理槽位」指针。每个 tick 至多推送一个槽位：跨停机落了多个
//           槽位时只推送最新一个（catchup），更早的槽位记入一次 missed 日志（绝不轰炸）；
//           指针推进到最新槽位之后（未来）；跳过的槽位不消耗次数，直至补满 total 次；
//           槽位全部耗尽（含被跳过）即按 total 收口为已完成。
//   cron    定时：next_at 到点 → 推送（catchup 若 next_at 已过 >60s），并把 next_at 重算到
//           严格未来的下一次。next_at 与 now 之间被跳过的更早触发记入一次 missed 日志
//           （最近一次仍以「补发」推送，与单次补发语义一致，绝不重复轰炸）。
//
// updates 按约定先于投递持久化（at-most-once：进程崩溃最多丢一次推送，不重复轰炸）；
// 因此 sent 在到点时即 +1，投递失败由 run.ts 的重试列（retry_at/retry_count）接管，
// 不再由本函数重复判到期。

import { countSkippedCronOccurrences, nextFire } from "./cron";

export const DEFAULT_GRACE_MS = 24 * 3600 * 1000;
/** 槽位/时间点错过超过该阈值即视为「补发」（catchup）。 */
export const CATCHUP_THRESHOLD_MS = 60 * 1000;

export type ReminderScheduleKind = "once" | "interval" | "cron";

/** computeDue 的输入行（store 行的纯数据投影，时间为 epoch ms）。 */
export type ScheduleLike = {
  id: number;
  reminderId: number;
  kind: ReminderScheduleKind;
  /** once：到点时间。 */
  at: number | null;
  /** interval：起始时间（首个槽位）。 */
  startAt: number | null;
  intervalSeconds: number | null;
  total: number | null;
  /** 已处理（推送/终局）次数：once 0/1；interval 已推送次数；cron 不使用。 */
  sent: number;
  cron: string | null;
  /** interval：下一个待处理槽位；cron：下一次触发。 */
  nextAt: number | null;
  enabled: boolean;
  /** once 已标记错过的时间；非空表示终局，不再到期。 */
  missedAt: number | null;
};

/** 停机跳过信息：写入 fire_log 的 missed 明细。 */
export type SkippedGap = {
  /** 跳过的槽位/触发次数。 */
  skipped: number;
  /** 被跳过时间段的起止（含）。 */
  fromMs: number;
  toMs: number;
  /** 恢复点（下一次未来触发；null = 调度就此结束）。 */
  nextMs: number | null;
};

/** 更新条目：契约形状 {id, next_at, sent, missed?}；missed=true 表示 once 错过，对象表示停机跳过。 */
export type ScheduleUpdate = {
  id: number;
  next_at: number | null;
  sent: number;
  missed?: true | SkippedGap;
};

export type DueItem = { schedule: ScheduleLike; catchup: boolean };

export type ComputeDueInput = {
  schedules: ScheduleLike[];
  now: number;
  graceMs?: number;
};

export type ComputeDueResult = {
  due: DueItem[];
  updates: ScheduleUpdate[];
};

/** 由调度行推导本轮到期对应的「计划时刻」（fire_log.scheduled_at 与重试恢复用）。 */
export function scheduledAtOf(s: ScheduleLike): number | null {
  if (s.kind === "once") return s.at;
  if (s.kind === "interval") {
    if (s.startAt === null || !s.intervalSeconds) return null;
    return s.nextAt ?? s.startAt + s.sent * s.intervalSeconds * 1000;
  }
  return s.nextAt;
}

function computeOnce(s: ScheduleLike, now: number, graceMs: number, due: DueItem[], updates: ScheduleUpdate[]): void {
  if (s.missedAt !== null || s.sent >= 1 || s.at === null || s.at > now) return;
  const lateMs = now - s.at;
  if (lateMs > graceMs) {
    // 错过超过宽限期：标记错过，不推送，不补发。
    updates.push({ id: s.id, next_at: null, sent: s.sent, missed: true });
    return;
  }
  due.push({ schedule: s, catchup: lateMs > CATCHUP_THRESHOLD_MS });
  updates.push({ id: s.id, next_at: null, sent: s.sent + 1 });
}

function computeInterval(s: ScheduleLike, now: number, due: DueItem[], updates: ScheduleUpdate[]): void {
  if (s.startAt === null || !s.intervalSeconds || s.intervalSeconds < 1) return;
  const total = s.total ?? 0;
  if (total < 1 || s.sent >= total) return;
  const stepMs = s.intervalSeconds * 1000;
  // 指针：下一个待处理槽位（创建时为 start_at，之后由 updates 维护；
  // next_at 为空时按 start_at + sent*interval 推导，兼容历史行）。
  const pointer = s.nextAt ?? s.startAt + s.sent * stepMs;
  if (pointer > now) return;
  const pointerIndex = Math.round((pointer - s.startAt) / stepMs);
  const remaining = Math.max(0, total - pointerIndex); // pointer 及之后尚存在的槽位数
  if (remaining <= 0) return;
  // 从 pointer 起已经过去的槽位数（含 pointer 本身）。
  const passed = Math.min(Math.floor((now - pointer) / stepMs) + 1, remaining);
  if (passed < 1) return;

  // 最新一个已过去槽位：本轮投递对象（多槽位跨越停机时只发它，绝不重复轰炸）。
  const latestIndex = pointerIndex + passed - 1;
  const latestPassed = pointer + (passed - 1) * stepMs;
  const nextIndex = latestIndex + 1;
  const next = nextIndex < total ? latestPassed + stepMs : null;
  due.push({ schedule: s, catchup: now - latestPassed > CATCHUP_THRESHOLD_MS });
  updates.push({
    id: s.id,
    next_at: next,
    // 槽位全部耗尽时按 total 收口（已完成）；否则只 +1（跳过的槽位不消耗次数，直至补满 total 次）。
    sent: next === null ? total : s.sent + 1,
    ...(passed >= 2
      ? {
          missed: {
            skipped: passed - 1,
            fromMs: pointer,
            toMs: pointer + (passed - 2) * stepMs,
            nextMs: next,
          } satisfies SkippedGap,
        }
      : {}),
  });
}

function computeCron(
  s: ScheduleLike,
  now: number,
  due: DueItem[],
  updates: ScheduleUpdate[],
  nextFire: (expr: string, after: Date) => Date | null,
  countSkipped: (expr: string, from: Date, until: Date) => number,
): void {
  if (!s.cron || s.nextAt === null) return;
  if (s.nextAt > now) return;
  due.push({ schedule: s, catchup: now - s.nextAt > CATCHUP_THRESHOLD_MS });
  const next = nextFire(s.cron, new Date(now));
  // next_at 与 now 之间被跳过的更早触发：记入一次 missed（最近一次已作为补发推送）。
  const skipped = countSkipped(s.cron, new Date(s.nextAt), new Date(now));
  updates.push({
    id: s.id,
    next_at: next === null ? null : next.getTime(),
    sent: s.sent,
    ...(skipped > 0
      ? {
          missed: {
            skipped,
            fromMs: s.nextAt,
            toMs: now,
            nextMs: next === null ? null : next.getTime(),
          } satisfies SkippedGap,
        }
      : {}),
  });
}

/**
 * computeDue：判定到期推送与行更新。纯函数：同输入恒同输出，不读库、不取当前时间。
 * due 与 updates 一一对应（due 项的更新由调度器在投递前持久化）；missed 更新没有对应 due 项。
 */
export function computeDue(input: ComputeDueInput): ComputeDueResult {
  const now = input.now;
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  const due: DueItem[] = [];
  const updates: ScheduleUpdate[] = [];
  for (const s of input.schedules) {
    if (!s.enabled) continue;
    if (s.kind === "once") computeOnce(s, now, graceMs, due, updates);
    else if (s.kind === "interval") computeInterval(s, now, due, updates);
    else if (s.kind === "cron") {
      // cron 的跳过统计依赖纯 cron 引擎（零依赖），直接注入避免环依赖。
      computeCron(s, now, due, updates, nextFireFn, countSkippedFn);
    }
  }
  return { due, updates };
}

// cron 引擎来自同目录纯模块 ./cron（零运行时依赖，客户端组件也会引用）。
const nextFireFn = (expr: string, after: Date): Date | null => nextFire(expr, after);
const countSkippedFn = (expr: string, from: Date, until: Date): number =>
  countSkippedCronOccurrences(expr, from, until);
