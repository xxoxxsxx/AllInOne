import Link from "next/link";
import type { ReactNode } from "react";

import { eventTypeLabels, type EventType } from "@/lib/ledger/schema";
import { formatShanghaiDateTime } from "@/lib/ledger/time";

type EventListItem = {
  cdk: string | null;
  counterparty_code: string | null;
  counterparty_name: string | null;
  created_at: string;
  event_type: EventType;
  id: string;
  note: string | null;
  occurred_at: string;
  package_code: string | null;
  package_name: string | null;
  platform_code: string | null;
  platform_name: string | null;
  related_cdk: string | null;
  updated_at: string | null;
};

type EventListProps = {
  emptyHint: string;
  headerActions?: ReactNode;
  items: EventListItem[];
  offset?: number;
  title: string;
};

function renderMetaLabel(item: EventListItem) {
  const parts = [
    item.package_name ?? item.package_code,
    item.platform_name ?? item.platform_code,
    item.counterparty_name ?? item.counterparty_code,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" / ") : "无额外配置";
}

export function EventList({
  emptyHint,
  headerActions,
  items,
  offset = 0,
  title,
}: EventListProps) {
  return (
    <section className="rounded-[28px] border border-border bg-surface p-6 shadow-[0_20px_60px_rgba(15,23,42,0.06)] sm:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.24em] text-accent">
            Events
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h2>
        </div>
        {headerActions ? (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {headerActions}
          </div>
        ) : null}
      </div>

      <div className="mt-6 space-y-3">
        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border px-4 py-5 text-sm text-muted">
            {emptyHint}
          </div>
        ) : null}

        {items.map((item, index) => {
          const isVoid = item.event_type === "void";

          return (
            <article
              key={item.id}
              className={
                isVoid
                  ? "rounded-2xl border border-rose-300 bg-rose-50/85 p-4"
                  : "rounded-2xl border border-border bg-white/85 p-4"
              }
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={
                        isVoid
                          ? "rounded-full bg-rose-100 px-2.5 py-1 text-xs font-medium text-rose-700"
                          : "rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-muted"
                      }
                    >
                      #{offset + index + 1}
                    </span>
                    <h3
                      className={
                        isVoid
                          ? "text-lg font-semibold tracking-tight text-rose-700"
                          : "text-lg font-semibold tracking-tight"
                      }
                    >
                      {eventTypeLabels[item.event_type]}
                    </h3>
                    <span
                      className={
                        isVoid
                          ? "rounded-full bg-rose-100 px-2.5 py-1 text-xs text-rose-700"
                          : "rounded-full bg-stone-100 px-2.5 py-1 text-xs text-muted"
                      }
                    >
                      {renderMetaLabel(item)}
                    </span>
                    {isVoid ? (
                      <span className="rounded-full bg-rose-600 px-2.5 py-1 text-xs font-medium text-white">
                        已作废
                      </span>
                    ) : null}
                  </div>

                  <div
                    className={
                      isVoid
                        ? "mt-3 grid gap-2 text-sm text-rose-700 sm:grid-cols-2"
                        : "mt-3 grid gap-2 text-sm text-muted sm:grid-cols-2"
                    }
                  >
                    <p>事件时间：{formatShanghaiDateTime(item.occurred_at)}</p>
                    <p>创建时间：{formatShanghaiDateTime(item.created_at)}</p>
                    <p>CDK：{item.cdk ?? "-"}</p>
                    <p>关联 CDK：{item.related_cdk ?? "-"}</p>
                  </div>

                  {item.note ? (
                    <p
                      className={
                        isVoid
                          ? "mt-3 text-sm leading-7 text-rose-700"
                          : "mt-3 text-sm leading-7 text-muted"
                      }
                    >
                      {item.note}
                    </p>
                  ) : null}
                </div>

                <Link
                  href={`/events/${item.id}`}
                  className={
                    isVoid
                      ? "inline-flex h-10 items-center justify-center rounded-2xl border border-rose-300 px-4 text-sm text-rose-700 transition hover:border-rose-500 hover:text-rose-800"
                      : "inline-flex h-10 items-center justify-center rounded-2xl border border-border px-4 text-sm text-foreground transition hover:border-accent hover:text-accent"
                  }
                >
                  查看详情
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
