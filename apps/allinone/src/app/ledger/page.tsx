import Link from "next/link";

import { DashboardStatCard } from "@/components/ledger/dashboard-stat-card";
import { EventList } from "@/components/ledger/event-list";
import { getDashboardStats, listRecentEvents } from "@/lib/ledger/events";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "内网 CDK 台账",
};

const quickLinks = [
  {
    href: "/config",
    kicker: "Ready",
    title: "基础配置",
    description: "管理套餐类型、下游对象和售卖平台，支持新增、启用、停用和默认项。",
  },
  {
    href: "/events/new",
    kicker: "Ready",
    title: "事件录入",
    description: "录入自营发货、下游代发、作废和换新 4 类核心事件。",
  },
  {
    href: "/events",
    kicker: "Ready",
    title: "明细与导出",
    description: "查看事件明细，按条件筛选，并导出当前筛选结果。",
  },
] as const;

export default async function LedgerDashboard() {
  const [stats, recentEvents] = await Promise.all([
    getDashboardStats(),
    listRecentEvents(10),
  ]);

  return (
    <main className="min-h-screen px-6 py-12">
      <div className="mx-auto w-full max-w-6xl">
        <a href="/" className="text-sm text-muted hover:text-accent">
          ← 工具箱
        </a>
      </div>
      <section className="mx-auto mt-4 w-full max-w-6xl rounded-[28px] border border-border bg-surface p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)] sm:p-12">
        <p className="text-sm uppercase tracking-[0.28em] text-accent">
          CDK Ledger App
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
          内网 CDK 台账
        </h1>

        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {quickLinks.map((item) => (
            <article
              key={item.title}
              className="flex h-full flex-col items-start rounded-2xl border border-border bg-white/80 p-5"
            >
              <p className="text-xs uppercase tracking-[0.22em] text-accent">
                {item.kicker}
              </p>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight">
                {item.title}
              </h2>
              <p className="mt-3 mb-6 text-sm leading-7 text-muted">
                {item.description}
              </p>
              <Link
                href={item.href}
                className="mt-auto inline-flex h-11 shrink-0 items-center justify-center rounded-2xl bg-accent px-5 text-sm font-medium text-white transition hover:opacity-90"
              >
                {item.href === "/config"
                  ? "进入配置页"
                  : item.href === "/events/new"
                    ? "进入录入页"
                    : "进入明细页"}
              </Link>
            </article>
          ))}
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <DashboardStatCard
            title="当前有效 CDK"
            value={stats.activeTotal}
            description="当前仍处于有效状态的 CDK 总数。"
          />
          <DashboardStatCard
            title="自营发货"
            value={stats.issueSelfActive}
            description="当前仍有效、归属于自营链路的 CDK 数量。"
          />
          <DashboardStatCard
            title="下游代发"
            value={stats.issueResellerActive}
            description="当前仍有效、归属于下游代发链路的 CDK 数量。"
          />
          <DashboardStatCard
            title="作废数量"
            value={stats.voidCount}
            description="历史上累计写入的作废事件数量。"
          />
        </div>

        <div className="mt-10">
          <EventList
            title="最近 10 条事件"
            items={recentEvents}
            emptyHint="当前还没有事件记录。"
          />
        </div>
      </section>
    </main>
  );
}
