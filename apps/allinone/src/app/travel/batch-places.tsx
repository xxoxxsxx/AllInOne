"use client";

import { useId, useMemo, useRef, useState } from "react";
import { MAX_BATCH_TEXT_LENGTH, parsePlaceLines } from "@/lib/travel/planning";
import { batchAddPlacesAction } from "./actions";
import "./batch-places.css";

export function BatchPlacesButton({ tripId, dayId, dayTitle }: {
  tripId: number;
  dayId: number | null;
  dayTitle: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const titleId = useId();
  const hintId = useId();
  const preview = useMemo(() => {
    try { return { names: parsePlaceLines(raw), error: "" }; }
    catch (e) { return { names: [], error: e instanceof Error ? e.message : "输入无效" }; }
  }, [raw]);

  const close = () => {
    if (!submitting.current) dialog.current?.close();
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    if (preview.error || !preview.names.length) {
      setError(preview.error || "请至少输入一个地点名称");
      return;
    }
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      const result = await batchAddPlacesAction(tripId, dayId, raw);
      if (!result.ok) { setError(result.error || "添加失败，请重试"); return; }
      dialog.current?.close();
      setRaw("");
    } catch {
      setError("请求失败，文本已保留。请先确认列表是否已添加，再重试，避免重复。");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <span className="travel-batch">
      <button type="button" className="travel-batch-open" onClick={() => {
        setError("");
        dialog.current?.showModal();
        input.current?.focus();
      }}>批量粘贴地点</button>
      <dialog ref={dialog} className="travel-batch-dialog" aria-labelledby={titleId}
        onCancel={(event) => { if (submitting.current) event.preventDefault(); }}>
        <form onSubmit={submit} aria-busy={pending}>
          <header><h2 id={titleId}>批量添加到「{dayTitle}」</h2>
            <button type="button" onClick={close} disabled={pending} aria-label="关闭批量添加">×</button>
          </header>
          <label className="travel-batch-label">地点名称（一行一个）
            <textarea ref={input} rows={7} value={raw} maxLength={MAX_BATCH_TEXT_LENGTH} disabled={pending}
              aria-describedby={hintId} placeholder={"中环\n太平山顶\n星光大道"}
              onChange={(event) => { setRaw(event.target.value); setError(""); }} />
          </label>
          <p id={hintId}>最多 50 个地点，每个名称最多 80 字；忽略空行，保留输入顺序和重复名称。确认后追加到末尾。</p>
          {error || preview.error ? <p className="travel-batch-error" role="alert">{error || preview.error}</p> : null}
          <section className="travel-batch-preview" aria-label="地点预览">
            <h3 aria-live="polite">预览：{preview.names.length} 个地点</h3>
            {preview.names.length ? <ol>{preview.names.map((name, index) => <li key={index}>{name}</li>)}</ol> : <p>粘贴后在这里确认地点列表。</p>}
          </section>
          <footer><button type="button" disabled={pending} onClick={close}>取消</button>
            <button type="submit" className="travel-batch-confirm" disabled={pending || !!preview.error || !preview.names.length}>
              {pending ? "添加中…" : `确认添加 ${preview.names.length} 个地点`}
            </button>
          </footer>
        </form>
      </dialog>
    </span>
  );
}
