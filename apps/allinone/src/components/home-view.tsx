import Link from "next/link";
import type { HomeModuleStats } from "@/lib/home-stats";

interface HomeViewProps {
  loadError: string | null;
  documentSummary: { expiring: number; expired: number } | null;
  documentReminderError: boolean;
  filmSummary: { expired: number; soon: number } | null;
  stats: HomeModuleStats;
}

export function HomeView({ loadError, documentSummary, documentReminderError, filmSummary, stats }: HomeViewProps) {
  const overview = [
    { href: "/reminders", label: "今日待办提醒", count: stats.remindersToday },
    { href: "/ledger", label: "有效 CDK", count: stats.cdkActive },
    { href: "/documents?status=expiring", label: "即将到期的证件", count: documentSummary?.expiring ?? null },
    { href: "/documents?status=expired", label: "已过期的证件", count: documentSummary?.expired ?? null },
    { href: "/stocks", label: "今日股票触发", count: stats.stockAlertsToday },
    { href: "/filmlog", label: "已过期的库存胶卷", count: filmSummary?.expired ?? null },
    { href: "/filmlog", label: "半年内到期的库存胶卷", count: filmSummary?.soon ?? null },
  ].filter(({ count }) => count !== null);

  return (
    <main className="portal-overview">
      <header className="ui-heading ui-heading-stack">
        <h1>工作台概览</h1>
        <p className="ui-subtitle">从菜单选择工具，直接在工作台使用。</p>
      </header>
      {loadError && <p className="error-banner" role="alert">工具配置加载失败：{loadError}</p>}
      {documentReminderError && <p className="error-banner" role="status">暂时无法读取证件到期信息，请打开证件夹检查。</p>}
      {overview.length > 0 && (
        <section aria-label="日常概览">
          <ul>
            {overview.map(({ href, label, count }) => (
              <li key={label}><Link href={href}><span>{label}</span><strong>{count}</strong><span aria-hidden="true">→</span></Link></li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
