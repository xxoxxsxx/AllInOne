import type { EventProfitSummary } from "@/lib/ledger/events";

type ProfitSummaryProps = {
  summary: EventProfitSummary;
};

function formatMoney(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(2, "0").slice(0, 2)} 元`;
}

function SummaryItem(props: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-white/85 p-4">
      <dt className="text-xs font-medium text-muted">{props.label}</dt>
      <dd className="mt-2 text-xl font-semibold tabular-nums text-foreground">
        {props.value}
      </dd>
    </div>
  );
}

export function ProfitSummary({ summary }: ProfitSummaryProps) {
  return (
    <section
      aria-live="polite"
      className="rounded-[28px] border border-accent/25 bg-accent/5 p-5 sm:p-6"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">
            Profit Summary
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
            毛利汇总（含已登记退款）
          </h2>
        </div>
        <span className="rounded-full bg-white px-3 py-1.5 text-sm tabular-nums text-muted">
          发货 {summary.issue_count} 条，退款/退回 {summary.refund_count} 条，已计算 {summary.priced_count} 条
        </span>
      </div>

      <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryItem label="净收入（扣退款）" value={formatMoney(summary.revenue)} />
        <SummaryItem label="净商品成本" value={formatMoney(summary.product_cost)} />
        <SummaryItem label="净平台手续费" value={formatMoney(summary.platform_fee)} />
        <SummaryItem label="总成本" value={formatMoney(summary.total_cost)} />
        <SummaryItem label="基础毛利" value={formatMoney(summary.gross_profit)} />
      </dl>

      <p className="mt-4 text-sm leading-7 text-muted">
        按各自事件时间及历史金额计算：退款冲减收入，实际退回的成本和手续费冲减成本。
        事件类型筛选同样适用，仅选发货不含退款；查看完整毛利请保留全部类型。
        作废和换新本身不自动冲销，未登记的退款和额外换新成本不计入。
        {summary.void_count > 0 ? ` 当前筛选有 ${summary.void_count} 条作废记录，请到详情核实是否已登记退款。` : ""}
        {summary.missing_price_count > 0
          ? ` 另有 ${summary.missing_price_count} 条缺少价格快照，未计入金额。`
          : ""}
      </p>
    </section>
  );
}
