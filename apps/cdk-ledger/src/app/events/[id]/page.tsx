import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";

import { updateEventAction } from "@/app/events/[id]/actions";
import { EventConfirmForm } from "@/components/event-confirm-form";
import { EventEditFields } from "@/components/event-edit-fields";
import { RefundForm } from "@/components/refund-form";
import { getRefundSource, listRefunds } from "@/lib/refunds";
import { toEventEditValues, withCurrentOption } from "@/lib/event-form";
import {
  getEventDetail,
  getEventGrossProfit,
  listEventFormOptions,
} from "@/lib/events";
import { eventTypeLabels } from "@/lib/schema";
import { formatShanghaiDateTime, getCurrentShanghaiDateTimeLocal, toDateTimeLocalValue } from "@/lib/time";
import { withBase } from "@/lib/base-path";

export const dynamic = "force-dynamic";

type EventDetailPageProps = {
  params: Promise<{ id: string }>;
};

function DetailRow(props: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-white/85 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-accent">{props.label}</p>
      <p className="mt-3 text-sm leading-7 text-foreground">{props.value}</p>
    </div>
  );
}

export default async function EventDetailPage({ params }: EventDetailPageProps) {
  const { id } = await params;
  const [event, options] = await Promise.all([getEventDetail(id), listEventFormOptions()]);

  if (!event) {
    notFound();
  }

  const refundSource = await getRefundSource(event);
  const refunds = refundSource ? await listRefunds(refundSource.id) : [];
  const packages = withCurrentOption(
    options.packages,
    event.package_code,
    event.package_name,
  );
  const platforms = withCurrentOption(
    options.platforms,
    event.platform_code,
    event.platform_name,
  );
  const resellers = withCurrentOption(
    options.resellers,
    event.counterparty_code,
    event.counterparty_name,
  );
  const initialValues = toEventEditValues({
    occurredAt: event.occurred_at,
    redeemedAt: event.redeemed_at,
    packageCode: event.package_code,
    platformCode: event.platform_code,
    counterpartyCode: event.counterparty_code,
    cdk: event.cdk,
    relatedCdk: event.related_cdk,
    note: event.note,
    costPrice: event.cost_price,
    salePrice: event.sale_price,
    supplyPrice: event.supply_price,
    platformFeeRatePercent: event.platform_fee_rate_percent,
    platformFeeFixedAmount: event.platform_fee_fixed_amount,
    platformFeeAmount: event.platform_fee_amount,
  });
  const hasPriceSnapshot =
    event.event_type === "issue_self" || event.event_type === "issue_reseller";

  return (
    <main className="min-h-screen px-6 py-8 sm:py-12">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <section className="rounded-[28px] border border-border bg-surface p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.28em] text-accent">
                Event Detail
              </p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight">
                {eventTypeLabels[event.event_type]}
              </h1>
              <p className="mt-4 text-base leading-8 text-muted">
                事件时间：{formatShanghaiDateTime(event.occurred_at)}
              </p>
              {event.redeemed_at ? (
                <p className="mt-1 text-sm leading-7 text-muted">
                  兑换时间：{formatShanghaiDateTime(event.redeemed_at)}
                </p>
              ) : null}
            </div>

            <Link
              href={withBase("/events")}
              className="inline-flex h-11 items-center justify-center rounded-2xl border border-border px-4 text-sm text-foreground transition hover:border-accent hover:text-accent"
            >
              返回明细页
            </Link>
          </div>

        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <DetailRow label="套餐类型" value={event.package_name ?? event.package_code ?? "-"} />
          <DetailRow label="售卖平台" value={event.platform_name ?? event.platform_code ?? "-"} />
          <DetailRow
            label="下游对象"
            value={event.counterparty_name ?? event.counterparty_code ?? "-"}
          />
          <DetailRow label="CDK" value={event.cdk ?? "-"} />
          <DetailRow label="关联 CDK" value={event.related_cdk ?? "-"} />
          <DetailRow
            label="兑换时间"
            value={event.redeemed_at ? formatShanghaiDateTime(event.redeemed_at) : "-"}
          />
          {hasPriceSnapshot ? (
            <>
              <DetailRow label="成本价" value={event.cost_price ? `${event.cost_price} 元` : "未记录"} />
              <DetailRow label="售卖价" value={event.sale_price ? `${event.sale_price} 元` : "未记录"} />
              <DetailRow label="供货价" value={event.supply_price ? `${event.supply_price} 元` : "未记录"} />
              <DetailRow
                label="平台手续费"
                value={event.platform_fee_amount ? `${event.platform_fee_amount} 元` : "未记录"}
              />
              <DetailRow
                label="基础毛利"
                value={getEventGrossProfit(event) ? `${getEventGrossProfit(event)} 元` : "未记录"}
              />
            </>
          ) : null}
          {event.event_type === "refund" ? (
            <>
              <DetailRow label="本次退款" value={`${event.refund_amount} 元`} />
              <DetailRow label="本次成本退回" value={`${event.cost_returned} 元`} />
              <DetailRow label="本次手续费退回" value={`${event.fee_returned} 元`} />
              <DetailRow label="本笔毛利影响" value={`${getEventGrossProfit(event)} 元`} />
            </>
          ) : null}
          <DetailRow label="创建时间" value={formatShanghaiDateTime(event.created_at)} />
          <DetailRow
            label="更新时间"
            value={event.updated_at ? formatShanghaiDateTime(event.updated_at) : "未更新"}
          />
        </section>

        <section className="rounded-[28px] border border-border bg-surface p-6 sm:p-8">
          <h2 className="text-2xl font-semibold">退款与成本退回</h2>
          <p className="mt-3 text-sm leading-7 text-muted">
            作废只改变 CDK 状态，不自动冲销收入和成本。请按实际情况登记退款；已有退款请修改对应记录，避免重复登记。
          </p>
          {refundSource ? (
            <>
              <p className="mt-3 text-sm leading-7">
                原发货：<Link className="text-accent underline" href={withBase(`/events/${refundSource.id}`)}>
                  {refundSource.cdk} · {formatShanghaiDateTime(refundSource.occurred_at)}
                </Link>
                <br />原收入 {refundSource.sale_price ?? refundSource.supply_price ?? "未记录"} 元，
                商品成本 {refundSource.cost_price ?? "未记录"} 元，手续费 {refundSource.platform_fee_amount ?? "0.00"} 元
              </p>
              <ul className="mt-4 space-y-2 text-sm">
                {refunds.map((refund) => (
                  <li key={refund.id} className="rounded-xl border border-border p-3">
                    <Link className="text-accent underline" href={withBase(`/events/${refund.id}`)}>
                      {formatShanghaiDateTime(refund.occurred_at)} · 查看/修改
                    </Link>
                    <p className="mt-1">退款 {refund.refund_amount} 元 · 成本退回 {refund.cost_returned} 元 · 手续费退回 {refund.fee_returned} 元</p>
                  </li>
                ))}
              </ul>
              {refunds.length === 0 ? <p className="mt-3 text-sm text-amber-800">尚未登记退款或确认无财务影响，请核实实际退款情况。</p> : null}
              <RefundForm
                key={event.id}
                id={event.event_type === "refund" ? event.id : randomUUID()}
                sourceId={refundSource.id}
                editing={event.event_type === "refund"}
                occurredAt={event.event_type === "refund" ? toDateTimeLocalValue(event.occurred_at) : getCurrentShanghaiDateTimeLocal()}
                refundAmount={event.refund_amount}
                costReturned={event.cost_returned}
                feeReturned={event.fee_returned}
                note={event.event_type === "refund" ? event.note : ""}
              />
            </>
          ) : <p className="mt-3 text-sm text-amber-800">未找到对应原发货记录，请在明细页找到原发货后登记退款。历史作废记录不会自动视为已退款。</p>}
        </section>

        {event.event_type !== "refund" && (!hasPriceSnapshot || refunds.length === 0) ? (
          <section className="rounded-[28px] border border-border bg-surface p-6 shadow-[0_20px_60px_rgba(15,23,42,0.06)] sm:p-8">
            <p className="text-sm uppercase tracking-[0.24em] text-accent">Edit</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">编辑事件</h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              事件类型、创建时间、更新时间保持只读。保存前会弹出二次确认，高风险字段在存在后续关联事件时禁止修改。
            </p>
            <EventConfirmForm
              action={updateEventAction}
              kind={event.event_type}
              mode="update"
              initialValues={initialValues}
            >
              <div className="mt-6 flex flex-col gap-5">
                <input type="hidden" name="id" value={event.id} />

                <EventEditFields
                  kind={event.event_type}
                  packages={packages}
                  platforms={platforms}
                  resellers={resellers}
                  resellerPackagePrices={options.resellerPackagePrices}
                  values={initialValues}
                  mode="update"
                />

                <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-border px-4 py-4 text-sm text-muted">
                  <p>编辑限制：</p>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>事件类型、创建时间、更新时间不可修改。</li>
                    <li>日期时间、CDK、关联 CDK 属于高风险字段，存在后续关联事件时禁止修改。</li>
                    <li>套餐类型、售卖平台、下游对象改成新值时，必须选择当前启用配置。</li>
                  </ul>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-muted">
                    保存后会立即刷新首页、明细页和当前详情页。
                  </p>
                  <button
                    type="submit"
                    className="inline-flex h-11 items-center justify-center rounded-2xl bg-accent px-5 text-sm font-medium text-white transition hover:opacity-90"
                  >
                    保存修改
                  </button>
                </div>
              </div>
            </EventConfirmForm>
          </section>
        ) : event.event_type !== "refund" ? <p className="text-sm text-muted">已有关联退款，原发货信息已锁定；退款金额可从对应退款详情修改。</p> : null}
      </div>
    </main>
  );
}
