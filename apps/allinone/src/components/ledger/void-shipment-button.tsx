"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { voidShipmentAction } from "@/app/(ledger)/events/[id]/actions";

export function VoidShipmentButton({ event }: {
  event: { id: string; cdk: string | null; occurred_at: string; created_at: string; updated_at: string | null };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  return (
    <>
      <button type="button" disabled={done} onClick={() => { setError(""); dialog.current?.showModal(); }}
        className="inline-flex h-10 items-center justify-center rounded-2xl border border-rose-300 px-4 text-sm text-rose-700 disabled:opacity-50">
        {done ? "已作废 CDK" : "作废 CDK"}
      </button>
      <dialog ref={dialog} aria-labelledby={titleId} onCancel={(e) => { if (pending) e.preventDefault(); }}
        className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-[28px] border border-border bg-surface p-6 text-foreground shadow-xl backdrop:bg-slate-950/45">
        <form onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          const data = new FormData(e.currentTarget);
          startTransition(async () => {
            try {
              const result = await voidShipmentAction(data);
              if (result.error) { setError(result.error); return; }
              setDone(true);
              dialog.current?.close();
              router.refresh();
            } catch {
              setError("作废提交失败，请刷新页面核实后重试。");
            }
          });
        }}>
          <h3 id={titleId} className="text-2xl font-semibold">确认作废 CDK</h3>
          <p className="mt-4 break-all text-sm">CDK：{event.cdk}</p>
          <p className="mt-3 text-sm leading-7 text-muted">作废后该 CDK 将失效。原出货记录、收入和成本保留，不自动退款；如有退款，请到详情登记。</p>
          <input type="hidden" name="id" value={event.id} />
          <input type="hidden" name="cdk" value={event.cdk ?? ""} />
          <input type="hidden" name="version" value={event.updated_at ?? event.created_at} />
          <input type="hidden" name="occurredAt" value={event.occurred_at} />
          <label className="mt-4 block text-sm">备注（选填）
            <textarea name="note" rows={3} disabled={pending} className="mt-2 w-full rounded-xl border border-border bg-white p-3" />
          </label>
          {error ? <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-3">
            <button type="button" disabled={pending} onClick={() => dialog.current?.close()} className="rounded-2xl border border-border px-4 py-3 disabled:opacity-50">取消</button>
            <button type="submit" disabled={pending} className="rounded-2xl bg-rose-600 px-4 py-3 text-white disabled:opacity-50">{pending ? "作废中…" : "确认作废"}</button>
          </div>
        </form>
      </dialog>
      {done ? <span role="status" className="text-xs text-muted">已记录作废，原账目保留。</span> : null}
    </>
  );
}
