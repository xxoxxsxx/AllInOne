import Link from "next/link";

import { createEventAction } from "@/app/(ledger)/events/new/actions";
import { EventEntryHistory } from "@/components/ledger/event-entry-history";
import { EventConfirmForm } from "@/components/ledger/event-confirm-form";
import { CdkPasteBox } from "@/components/ledger/cdk-paste-box";
import { EventEditFields } from "@/components/ledger/event-edit-fields";
import { toEventEditValues } from "@/lib/ledger/event-form";
import {
  buildEventHistoryEntry,
  getEventFormDefaults,
  getEventKindOptions,
  isEventKind,
  listEventFormOptions,
  listRecentEvents,
} from "@/lib/ledger/events";
import { eventTypeLabels, type EventType } from "@/lib/ledger/schema";
import { formatShanghaiDateTime } from "@/lib/ledger/time";

export const dynamic = "force-dynamic";

type EventPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type PageSearchParams = Record<string, string | string[] | undefined>;

function getSingleValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function getEventKind(value: string | undefined): EventType {
  if (value !== "refund" && isEventKind(value ?? "")) {
    return value as EventType;
  }

  return "issue_self";
}

export default async function EventNewPage({
  searchParams,
}: EventPageProps) {
  const [options, params, recentEntries] = await Promise.all([
    listEventFormOptions(),
    searchParams ?? Promise.resolve<PageSearchParams>({}),
    listRecentEvents(3, "created"),
  ]);

  const selectedType = getSingleValue(params.type);
  const kind = getEventKind(selectedType);
  const values = getEventFormDefaults(kind, options.defaults);
  const historyItems = recentEntries.map((event) =>
    buildEventHistoryEntry(event.event_type, {
      occurredAt: formatShanghaiDateTime(event.occurred_at),
      redeemedAt: event.redeemed_at
        ? formatShanghaiDateTime(event.redeemed_at)
        : undefined,
      packageCode: event.package_code ?? undefined,
      platformCode: event.platform_code ?? undefined,
      counterpartyCode: event.counterparty_code ?? undefined,
      cdk: event.cdk ?? undefined,
      oldCdk: event.cdk ?? undefined,
      newCdk: event.related_cdk ?? undefined,
    }),
  );

  return (
    <main className="min-h-screen px-6 py-8 sm:py-12">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <section className="rounded-[28px] border border-border bg-surface p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.28em] text-accent">
                Phase 5 Ready
              </p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight">
                新增事件
              </h1>
              <p className="mt-4 max-w-3xl text-base leading-8 text-muted">
                支持发货、作废和换新。退款或成本退回请从原发货或作废记录的详情页录入。
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href="/config"
                className="inline-flex h-11 items-center justify-center rounded-2xl border border-border px-4 text-sm text-foreground transition hover:border-accent hover:text-accent"
              >
                基础配置
              </Link>
              <Link
                href="/ledger"
                className="inline-flex h-11 items-center justify-center rounded-2xl border border-border px-4 text-sm text-foreground transition hover:border-accent hover:text-accent"
              >
                返回台账首页
              </Link>
            </div>
          </div>

        </section>

        <section className="rounded-[28px] border border-border bg-surface p-6 shadow-[0_20px_60px_rgba(15,23,42,0.06)] sm:p-8">
          <div className="flex flex-wrap gap-2">
            {getEventKindOptions().filter((item) => item.value !== "refund").map((item) => (
              <Link
                key={item.value}
                href={`/events/new?type=${item.value}`}
                className={
                  item.value === kind
                    ? "inline-flex h-11 items-center justify-center rounded-2xl bg-accent px-4 text-sm font-medium text-white"
                    : "inline-flex h-11 items-center justify-center rounded-2xl border border-border px-4 text-sm text-foreground transition hover:border-accent hover:text-accent"
                }
              >
                {item.label}
              </Link>
            ))}
          </div>

          <div className="mt-6">
            <h2 className="text-2xl font-semibold tracking-tight">
              {eventTypeLabels[kind]}
            </h2>
            <p className="mt-2 text-sm leading-7 text-muted">
              {kind === "issue_self"
                ? "记录一条由自己直接发出的有效 CDK。"
                : null}
              {kind === "issue_reseller"
                ? "记录一条发给下游对象的有效 CDK。"
                : null}
              {kind === "void"
                ? "记录某条 CDK 的作废事件。"
                : null}
              {kind === "replace"
                ? "记录旧 CDK 失效并由新 CDK 接替。"
                : null}
            </p>
          </div>

          <EventConfirmForm action={createEventAction} kind={kind} mode="create">
            <div className="mt-6 space-y-6">
              <input type="hidden" name="kind" value={kind} />

              <CdkPasteBox kind={kind} />

              <EventEditFields
                kind={kind}
                packages={options.packages}
                platforms={options.platforms}
                resellers={options.resellers}
                resellerPackagePrices={options.resellerPackagePrices}
                useSubmitTimeDefaults
                values={toEventEditValues({
                  occurredAt: values.occurredAt,
                  redeemedAt: values.redeemedAt,
                  packageCode: values.packageCode,
                  platformCode: values.platformCode,
                  counterpartyCode: values.counterpartyCode,
                  cdk: kind === "replace" ? values.oldCdk : values.cdk,
                  relatedCdk: values.newCdk,
                  note: values.note,
                })}
              />

              <div className="sticky bottom-4 z-10 -mx-2 rounded-[24px] border border-border bg-surface/95 px-4 py-4 shadow-[0_16px_40px_rgba(15,23,42,0.12)] backdrop-blur sm:mx-0 sm:px-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">录入完成后直接提交</p>
                    <p className="mt-1 text-sm text-muted">
                      提交前会先弹出确认窗，重点核对当前 CDK。
                    </p>
                  </div>
                  <button
                    type="submit"
                    className="inline-flex h-11 w-full items-center justify-center rounded-2xl bg-accent px-5 text-sm font-medium text-white transition hover:opacity-90 sm:w-auto sm:min-w-36"
                  >
                    提交事件
                  </button>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-border px-4 py-4 text-sm text-muted">
                  <p className="text-sm font-medium text-foreground">当前校验规则</p>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>自营发货和下游代发不能重复登记当前有效 CDK。</li>
                    <li>换新要求旧 CDK 已存在且当前有效，新 CDK 当前不能有效。</li>
                    <li>作废要求 CDK 在历史中至少出现过一次。</li>
                    <li>默认配置会自动带出套餐类型、自营/换新的售卖平台和默认下游对象。</li>
                    <li>套餐类型和下游对象必须从启用配置中选择；售卖平台仅自营和换新需要选择。</li>
                    <li>正式提交前会弹出确认弹窗，重点核对当前 CDK。</li>
                  </ul>
                </div>

                <EventEntryHistory items={historyItems} />
              </div>
            </div>
          </EventConfirmForm>
        </section>
      </div>
    </main>
  );
}
