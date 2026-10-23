import { dbQuery, withTransaction } from "@/lib/db";
import { getEventDetail } from "@/lib/events";
import type { EventRecord } from "@/lib/schema";
import { toShanghaiIsoString } from "@/lib/time";

function money(value: string, label: string) {
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(value.trim())) {
    throw new Error(`${label}需填写非负金额，最多两位小数。`);
  }
  const [whole, fraction = ""] = value.trim().split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

// Walk backwards through replacements, bounded by each event's time and identity.
export async function getRefundSource(event: EventRecord) {
  if (event.event_type === "refund") {
    return event.source_event_id ? getEventDetail(event.source_event_id) : null;
  }
  let current = event;
  const seen = new Set<string>();
  while (!seen.has(current.id)) {
    seen.add(current.id);
    if (current.event_type === "issue_self" || current.event_type === "issue_reseller") {
      return getEventDetail(current.id);
    }
    const result = await dbQuery<{ id: string }>(`
      select id from events
      where ((event_type in ('issue_self', 'issue_reseller') and cdk = $1)
        or (event_type = 'replace' and related_cdk = $1))
        and (occurred_at, created_at, id) < (select occurred_at, created_at, id from events where id = $2)
      order by occurred_at desc, created_at desc, id desc limit 1
    `, [current.cdk, current.id]);
    const previous = result.rows[0] ? await getEventDetail(result.rows[0].id) : null;
    if (!previous) return null;
    current = previous;
  }
  return null;
}

export async function listRefunds(sourceId: string) {
  const result = await dbQuery<EventRecord>(`
    select * from events where source_event_id = $1
    order by occurred_at, created_at, id
  `, [sourceId]);
  return result.rows;
}

export async function saveRefund(input: {
  id: string;
  sourceId: string;
  editing: boolean;
  occurredAt: string;
  refundAmount: string;
  costReturned: string;
  feeReturned: string;
  note: string;
}) {
  const amounts = [
    money(input.refundAmount, "退款金额"),
    money(input.costReturned, "成本退回"),
    money(input.feeReturned, "手续费退回"),
  ];
  const occurredAt = toShanghaiIsoString(input.occurredAt);
  await withTransaction(async (query) => {
    // Serialize refunds and original-order edits on the same row.
    const sourceResult = await query<EventRecord>(
      "select * from events where id = $1 for update", [input.sourceId],
    );
    const source = sourceResult.rows[0];
    if (!source || !["issue_self", "issue_reseller"].includes(source.event_type)) {
      throw new Error("退款必须关联原发货记录。");
    }
    const revenue = source.event_type === "issue_self" ? source.sale_price : source.supply_price;
    if (revenue === null || source.cost_price === null) {
      throw new Error("请先补全原发货记录的价格快照，再登记退款。");
    }
    if (new Date(occurredAt) < new Date(source.occurred_at)) {
      throw new Error("退款时间不能早于原发货时间。");
    }
    const existing = await query<EventRecord>("select * from events where id = $1 for update", [input.id]);
    if (input.editing) {
      if (existing.rows[0]?.event_type !== "refund" || existing.rows[0].source_event_id !== source.id) {
        throw new Error("退款记录不存在或原单不匹配。");
      }
    } else if (existing.rows.length) {
      throw new Error("该退款已提交，请勿重复提交；如需修改，请打开退款详情。");
    }
    const totals = await query<{ refund: string; cost: string; fee: string }>(`
      select coalesce(sum(refund_amount), 0)::text as refund,
        coalesce(sum(cost_returned), 0)::text as cost,
        coalesce(sum(fee_returned), 0)::text as fee
      from events where source_event_id = $1 and id <> $2
    `, [source.id, input.id]);
    const total = totals.rows[0];
    const caps = [revenue, source.cost_price, source.platform_fee_amount ?? "0"];
    const used = [total.refund, total.cost, total.fee];
    const labels = ["退款金额", "成本退回", "手续费退回"];
    for (let index = 0; index < amounts.length; index++) {
      if (amounts[index] + money(used[index], labels[index]) > money(caps[index], labels[index])) {
        throw new Error(`累计${labels[index]}不能超过原单对应金额（${caps[index]} 元）。`);
      }
    }
    const values = [input.id, occurredAt, ...amounts.map((value) => (value / 100).toFixed(2)), input.note.trim() || null];
    if (input.editing) {
      await query(`update events set occurred_at = $2, refund_amount = $3,
        cost_returned = $4, fee_returned = $5, note = $6 where id = $1`, values);
    } else {
      await query(`insert into events (id, event_type, occurred_at, refund_amount,
        cost_returned, fee_returned, note, source_event_id, cdk, package_code,
        platform_code, counterparty_code)
        values ($1, 'refund', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [...values, source.id, source.cdk, source.package_code, source.platform_code, source.counterparty_code]);
    }
  });
}
