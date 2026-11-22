import Link from "next/link";
import type { HomeModuleStats } from "@/lib/home-stats";

interface HomeViewProps {
  loadError: string | null;
  documentSummary: { expiring: number; expired: number } | null;
  documentReminderError: boolean;
  filmSummary: { expired: number; soon: number } | null;
  fundingPending: number | null;
  stats: HomeModuleStats;
}

export function HomeView({ loadError, documentSummary, documentReminderError, filmSummary, fundingPending, stats }: HomeViewProps) {
  const overview = [
    { href: "/reminders", label: "今日待办提醒", count: stats.remindersToday },
    { href: "/funding#fund-review", label: "资金来源与路径待核实", count: fundingPending },
    { href: "/documents?status=expiring", label: "即将到期的证件", count: documentSummary?.expiring ?? null },
    { href: "/documents?status=expired", label: "已过期的证件", count: documentSummary?.expired ?? null },
    { href: "/filmlog", label: "已过期的库存胶卷", count: filmSummary?.expired ?? null },
    { href: "/filmlog", label: "半年内到期的库存胶卷", count: filmSummary?.soon ?? null },
  ].filter(({ count }) => count !== null && count > 0);
  const activity = [
    { href: "/stocks", label: "今日股票触发", count: stats.stockAlertsToday },
    { href: "/ledger", label: "有效 CDK", count: stats.cdkActive },
  ].filter(({ count }) => count !== null);

  return (
    <main className="portal-overview">
      <header className="ui-heading ui-heading-stack">
        <h1>工作台概览</h1>
        <p className="ui-subtitle">从菜单选择工具，直接在工作台使用。</p>
      </header>
      {loadError && <p className="error-banner" role="alert">工具配置加载失败：{loadError}</p>}
      {documentReminderError && <p className="error-banner" role="status">暂时无法读取证件到期信息，请打开证件夹检查。</p>}
      <div className="ui-split">
        <section className="ui-panel" aria-label="待处理事项">
          <h2>待处理事项</h2>
          {overview.length === 0 && <p>当前没有待处理事项。</p>}
          <ul>
            {overview.map(({ href, label, count }) => (
              <li key={label}><Link href={href}><span>{label}</span><strong>{count}</strong><span aria-hidden="true">→</span></Link></li>
            ))}
          </ul>
        </section>
        {activity.length > 0 && <aside className="ui-rail" aria-label="模块动态">
          <section className="ui-panel">
            <h2>模块动态</h2>
            <ul>
              {activity.map(({ href, label, count }) => (
                <li key={label}><Link href={href}><span>{label}</span><strong>{count}</strong><span aria-hidden="true">→</span></Link></li>
              ))}
            </ul>
          </section>
        </aside>}
      </div>
    </main>
  );
}
