"use client";

import { useState } from "react";
import { saveRefundAction } from "@/app/(ledger)/events/[id]/actions";
import { showToast } from "@/components/ledger/toast";

export function RefundForm(props: {
  id: string;
  sourceId: string;
  editing: boolean;
  occurredAt: string;
  refundAmount?: string | null;
  costReturned?: string | null;
  feeReturned?: string | null;
  note?: string | null;
}) {
  const [values, setValues] = useState({
    occurredAt: props.occurredAt,
    refundAmount: props.refundAmount ?? "0",
    costReturned: props.costReturned ?? "0",
    feeReturned: props.feeReturned ?? "0",
    note: props.note ?? "",
  });
  const [pending, setPending] = useState(false);
  const inputClass = "h-11 rounded-xl border border-border bg-white px-3 text-sm";
  return (
    <form className="mt-5 space-y-4" action={async (formData) => {
      setPending(true);
      try {
        const result = await saveRefundAction(formData);
        if (result?.error) {
          showToast(result.error, { tone: "error" });
        }
      } finally {
        setPending(false);
      }
    }}>
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="sourceId" value={props.sourceId} />
      <input type="hidden" name="editing" value={props.editing ? "1" : "0"} />
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          退款/退回时间（北京时间）
          <input className={inputClass} type="datetime-local" name="occurredAt" required value={values.occurredAt} onChange={(event) => setValues({ ...values, occurredAt: event.target.value })} />
        </label>
        {([
          ["refundAmount", "退给客户/下游的金额（元）"],
          ["costReturned", "实际收回的商品成本（元）"],
          ["feeReturned", "平台退回的手续费（元）"],
        ] as const).map(([name, label]) => (
          <label key={name} className="flex flex-col gap-2 text-sm">
            {label}
            <input className={inputClass} name={name} type="number" min="0" max="9999999999.99" step="0.01" required value={values[name]} onChange={(event) => setValues({ ...values, [name]: event.target.value })} />
          </label>
        ))}
      </div>
      <label className="flex flex-col gap-2 text-sm">
        说明
        <textarea className="rounded-xl border border-border bg-white p-3" name="note" rows={2} value={values.note} onChange={(event) => setValues({ ...values, note: event.target.value })} />
      </label>
      <p className="text-sm leading-7 text-muted">只填写本次实际金额，未退回的项目填 0。三项都为 0 表示已确认无财务影响。退款不改变 CDK 有效状态。</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" required /> 已核对本次退款、成本和手续费退回金额
      </label>
      <button disabled={pending} className="h-11 rounded-xl bg-accent px-5 text-sm font-medium text-white disabled:opacity-50">
        {pending ? "保存中…" : props.editing ? "保存退款修改" : "登记本次退款/退回"}
      </button>
    </form>
  );
}
