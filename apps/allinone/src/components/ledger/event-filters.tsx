import Link from "next/link";
import type { ReactNode } from "react";

import type { ConfigOption } from "@/lib/ledger/config";
import type { EventFilters } from "@/lib/ledger/events";
import { getEventKindOptions } from "@/lib/ledger/events";

type EventFiltersProps = {
  filters: EventFilters;
  hiddenFields?: ReactNode;
  packages: ConfigOption[];
  platforms: ConfigOption[];
  resellers: ConfigOption[];
};

export function EventFiltersForm({
  filters,
  hiddenFields,
  packages,
  platforms,
  resellers,
}: EventFiltersProps) {
  const formKey = [
    filters.dateFrom,
    filters.dateTo,
    filters.eventType,
    filters.cdk,
    filters.note,
    filters.packageCode,
    filters.platformCode,
    filters.counterpartyCode,
  ].join("|");

  return (
    <form key={formKey} className="space-y-3">
      {hiddenFields}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">开始日期</span>
          <input
            type="date"
            name="dateFrom"
            defaultValue={filters.dateFrom}
            className="h-11 w-full min-w-0 rounded-2xl border border-border bg-white px-4 text-[15px] outline-none transition focus:border-accent"
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">结束日期</span>
          <input
            type="date"
            name="dateTo"
            defaultValue={filters.dateTo}
            className="h-11 w-full min-w-0 rounded-2xl border border-border bg-white px-4 text-[15px] outline-none transition focus:border-accent"
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">事件类型</span>
          <select
            name="eventType"
            defaultValue={filters.eventType}
            className="h-11 rounded-2xl border border-border bg-white px-4 text-sm outline-none transition focus:border-accent"
          >
            <option value="">全部类型</option>
            {getEventKindOptions().map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">CDK</span>
          <input
            type="text"
            name="cdk"
            defaultValue={filters.cdk}
            placeholder="输入 CDK"
            className="h-11 rounded-2xl border border-border bg-white px-4 text-sm uppercase outline-none transition focus:border-accent"
          />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">备注内容</span>
          <input
            type="text"
            name="note"
            defaultValue={filters.note}
            placeholder="搜索备注内容"
            className="h-11 rounded-2xl border border-border bg-white px-4 text-sm outline-none transition focus:border-accent"
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">套餐类型</span>
          <select
            name="packageCode"
            defaultValue={filters.packageCode}
            className="h-11 rounded-2xl border border-border bg-white px-4 text-sm outline-none transition focus:border-accent"
          >
            <option value="">全部套餐</option>
            {packages.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name} ({item.code})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">售卖平台</span>
          <select
            name="platformCode"
            defaultValue={filters.platformCode}
            className="h-11 rounded-2xl border border-border bg-white px-4 text-sm outline-none transition focus:border-accent"
          >
            <option value="">全部平台</option>
            {platforms.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name} ({item.code})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">下游对象</span>
          <select
            name="counterpartyCode"
            defaultValue={filters.counterpartyCode}
            className="h-11 rounded-2xl border border-border bg-white px-4 text-sm outline-none transition focus:border-accent"
          >
            <option value="">全部下游</option>
            {resellers.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name} ({item.code})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="submit"
          className="inline-flex h-11 items-center justify-center rounded-2xl bg-accent px-5 text-sm font-medium text-white transition hover:opacity-90"
        >
          应用筛选
        </button>
        <button
          type="submit"
          name="calculate"
          value="1"
          className="inline-flex h-11 items-center justify-center rounded-2xl border border-accent px-5 text-sm font-medium text-accent transition hover:bg-accent hover:text-white"
        >
          计算基础毛利
        </button>
        <Link
          href="/events"
          className="inline-flex h-11 items-center justify-center rounded-2xl border border-border px-5 text-sm text-foreground transition hover:border-accent hover:text-accent"
        >
          清空筛选
        </Link>
      </div>
    </form>
  );
}
