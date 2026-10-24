"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Refresh server-rendered results without resetting the scroll position or countdown.
export function RunProgress({ active, nextRequestAt }: { active: boolean; nextRequestAt?: string | null }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [clock, setClock] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => setClock(Date.now()), 1000);
    const refresh = setInterval(() => startTransition(() => router.refresh()), 3000);
    return () => { clearInterval(tick); clearInterval(refresh); };
  }, [active, router]);
  if (!active) return null;
  const until = nextRequestAt ? Date.parse(nextRequestAt) : NaN;
  const seconds = clock !== null && Number.isFinite(until) ? Math.max(0, Math.ceil((until - clock) / 1000)) : null;
  return <p id="poll-message" className="muted small" role="status">
    {nextRequestAt
      ? seconds === null ? "正在等待额度，预计恢复后继续本轮查询。" : seconds > 0 ? `正在等待额度，下次请求预计 ${seconds} 秒后执行。` : "正在重新检查额度，请稍候…"
      : "正在分批查询，结果每 3 秒自动更新；每只股票查到报价后立即判断提醒。"}
  </p>;
}
