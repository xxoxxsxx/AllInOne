import Link from "next/link";

import { EventFiltersForm } from "@/components/event-filters";
import { EventList } from "@/components/event-list";
import { ProfitSummary } from "@/components/profit-summary";
import { listActiveConfigOptions } from "@/lib/config";
import {
  eventExportLimit,
  eventPageSizeOptions,
  getEventListTitle,
  getEventProfitSummary,
  listEventDetailsPage,
  parseEventPage,
  parseEventFilters,
  parseEventPageSize,
  shouldCalculateEventProfit,
} from "@/lib/events";

export const dynamic = "force-dynamic";

type EventsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type PageSearchParams = Record<string, string | string[] | undefined>;

function toSearchString(params: PageSearchParams) {
  const search = new URLSearchParams();

  for (const [key, rawValue] of Object.entries(params)) {
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value) {
      search.set(key, value);
    }
  }

  return search.toString();
}

export default async function EventsPage({ searchParams }: EventsPageProps) {
  const [params, packages, platforms, resellers] = await Promise.all([
    searchParams ?? Promise.resolve<PageSearchParams>({}),
    listActiveConfigOptions("package"),
    listActiveConfigOptions("platform"),
    listActiveConfigOptions("reseller"),
  ]);

  const filters = parseEventFilters(params);
  const page = parseEventPage(params);
  const pageSize = parseEventPageSize(params);
  const calculateProfit = shouldCalculateEventProfit(params);
  const [result, profitSummary] = await Promise.all([
    listEventDetailsPage(filters, page, pageSize),
    calculateProfit ? getEventProfitSummary(filters) : Promise.resolve(null),
  ]);
  const exportQuery = toSearchString({
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    eventType: filters.eventType,
    cdk: filters.cdk,
    note: filters.note,
    packageCode: filters.packageCode,
    platformCode: filters.platformCode,
    counterpartyCode: filters.counterpartyCode,
  });
  const hasPreviousPage = result.page > 1;
  const hasNextPage = result.page < result.totalPages;
  const canExport = result.total > 0 && result.total <= eventExportLimit;
  const offset = (result.page - 1) * result.pageSize;

  function buildEventsHref(nextParams: PageSearchParams) {
    const query = toSearchString({
      ...params,
      ...nextParams,
    });

    return `/events${query ? `?${query}` : ""}`;
  }

  return (
    <main className="min-h-screen px-6 py-8 sm:py-12">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <section className="rounded-[28px] border border-border bg-surface p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.28em] text-accent">
                Phase 6 Ready
              </p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight">
                事件明细
              </h1>
              <p className="mt-4 max-w-3xl text-base leading-8 text-muted">
                支持按日期、事件类型、CDK、备注内容、套餐类型、售卖平台和下游对象筛选，并可按当前条件计算基础毛利。CSV 导出严格复用当前筛选条件。
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href="/events/new"
                className="inline-flex h-11 items-center justify-center rounded-2xl border border-border px-4 text-sm text-foreground transition hover:border-accent hover:text-accent"
              >
                新增事件
              </Link>
              <Link
                href="/"
                className="inline-flex h-11 items-center justify-center rounded-2xl border border-border px-4 text-sm text-foreground transition hover:border-accent hover:text-accent"
              >
                返回首页
              </Link>
            </div>
          </div>

          <div className="mt-6">
            <EventFiltersForm
              key={exportQuery || "empty"}
              filters={filters}
              hiddenFields={
                <>
                  <input type="hidden" name="pageSize" value={String(pageSize)} />
                  <input type="hidden" name="page" value="1" />
                </>
              }
              packages={packages}
              platforms={platforms}
              resellers={resellers}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>
              当前结果：{result.total} 条
              {result.total > 0
                ? ` · 第 ${result.page}/${result.totalPages} 页`
                : ""}
            </span>
            {canExport ? (
              <a
                href={`/events/export${exportQuery ? `?${exportQuery}` : ""}`}
                className="inline-flex h-10 items-center justify-center rounded-2xl bg-accent px-4 text-sm font-medium text-white transition hover:opacity-90"
              >
                导出 CSV
              </a>
            ) : result.total > eventExportLimit ? (
              <span className="inline-flex min-h-10 items-center rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
                当前结果超过 {eventExportLimit} 条，请缩小筛选范围后再导出
              </span>
            ) : (
              <span className="inline-flex h-10 items-center justify-center rounded-2xl border border-dashed border-border px-4 text-sm text-muted">
                没有可导出的数据
              </span>
            )}
          </div>

          {profitSummary ? (
            <div className="mt-5">
              <ProfitSummary summary={profitSummary} />
            </div>
          ) : null}
        </section>

        <EventList
          title={getEventListTitle(filters)}
          items={result.items}
          offset={offset}
          emptyHint="当前筛选条件下没有匹配事件。"
          headerActions={
            result.total > 0 ? (
              <>
                <div className="flex items-center gap-2 rounded-2xl border border-border bg-white/85 p-1 text-sm">
                  <span className="px-2 text-muted">每页</span>
                  {eventPageSizeOptions.map((size) => (
                    <Link
                      key={size}
                      href={buildEventsHref({
                        page: "1",
                        pageSize: String(size),
                      })}
                      className={
                        size === pageSize
                          ? "inline-flex h-9 items-center justify-center rounded-xl bg-accent px-3 font-medium text-white"
                          : "inline-flex h-9 items-center justify-center rounded-xl px-3 text-muted transition hover:text-accent"
                      }
                    >
                      {size}
                    </Link>
                  ))}
                  <span className="pr-2 text-muted">条</span>
                </div>

                <span className="rounded-2xl border border-dashed border-border px-3 py-2 text-sm text-muted">
                  第 {result.page} / {result.totalPages} 页
                </span>

                {hasPreviousPage ? (
                  <Link
                    href={buildEventsHref({ page: String(result.page - 1) })}
                    className="inline-flex h-11 items-center justify-center rounded-2xl border border-border px-4 text-sm text-foreground transition hover:border-accent hover:text-accent"
                  >
                    上一页
                  </Link>
                ) : (
                  <span className="inline-flex h-11 items-center justify-center rounded-2xl border border-dashed border-border px-4 text-sm text-muted">
                    上一页
                  </span>
                )}

                {hasNextPage ? (
                  <Link
                    href={buildEventsHref({ page: String(result.page + 1) })}
                    className="inline-flex h-11 items-center justify-center rounded-2xl border border-border px-4 text-sm text-foreground transition hover:border-accent hover:text-accent"
                  >
                    下一页
                  </Link>
                ) : (
                  <span className="inline-flex h-11 items-center justify-center rounded-2xl border border-dashed border-border px-4 text-sm text-muted">
                    下一页
                  </span>
                )}
              </>
            ) : null
          }
        />
      </div>
    </main>
  );
}
