"use client";

// 提醒事项客户端 UI：卡片列表（按下次触发排序、状态徽章、图片缩略图）与新建/编辑表单
// （文字 + 多图片上传预览 + 多条调度编辑：单次/间隔/cron；cron 输入实时预览未来 5 次触发，
//  解析错误就地展示）。数据变更全部走 Server Actions，成功后 router.refresh() 重新下发最新列表。
// 引用的 cron.ts / constants.ts 均为无 Node 依赖的纯模块，可安全进入客户端包。

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { nextFires, parseCron } from "@/lib/reminders/cron";
import {
  INTERVAL_UNIT_LABELS,
  INTERVAL_UNIT_SECONDS,
  REMINDERS_MAX_IMAGE_BYTES,
  REMINDERS_MAX_IMAGES,
  REMINDERS_MAX_TEXT_LENGTH,
  intervalToValueUnit,
  type IntervalUnit,
} from "@/lib/reminders/constants";
import type { ScheduleInput } from "@/lib/reminders/store";

import {
  deleteReminderAction,
  deleteReminderImageAction,
  saveReminderAction,
  setReminderEnabledAction,
  testReminderAction,
  type SaveReminderPayload,
} from "./actions";

export type ReminderStatus = "active" | "paused" | "done" | "missed";

export type ScheduleCard = {
  id: number;
  kind: "once" | "interval" | "cron";
  at: string | null;
  startAt: string | null;
  intervalSeconds: number | null;
  total: number | null;
  sent: number;
  cron: string | null;
  nextAt: string | null;
  enabled: boolean;
  missedAt: string | null;
};

export type ImageCard = { id: number; storedName: string; originalName: string; mime: string; size: number };

export type ReminderCard = {
  id: number;
  text: string;
  enabled: boolean;
  images: ImageCard[];
  schedules: ScheduleCard[];
  nextAt: string | null;
  status: ReminderStatus;
};

const STATUS_LABELS: Record<ReminderStatus, string> = {
  active: "进行中",
  paused: "已暂停",
  done: "已完成",
  missed: "已错过",
};

const KIND_LABELS = { once: "单次", interval: "间隔", cron: "cron" } as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** ISO（UTC）→ 本地 "YYYY-MM-DD HH:mm"。 */
function fmtLocal(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** ISO → datetime-local 输入值（本地 "YYYY-MM-DDTHH:mm"）。 */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`;
  if (size >= 1024) return `${Math.round(size / 1024)}KB`;
  return `${size}B`;
}

function attachmentUrl(reminderId: number, storedName: string): string {
  return `/reminders/attachments/${reminderId}/${storedName}`;
}

// —— 编辑器行状态 ——

type EditorSchedule = {
  key: string;
  kind: "once" | "interval" | "cron";
  at: string;
  startAt: string;
  intervalValue: string;
  unit: IntervalUnit;
  total: string;
  cron: string;
};

type StagedImage = { key: string; file: File; url: string };

let rowSeq = 0;
function nextRowKey(): string {
  rowSeq += 1;
  return `row-${Date.now().toString(36)}-${rowSeq}`;
}

function emptyRow(): EditorSchedule {
  return { key: nextRowKey(), kind: "once", at: "", startAt: "", intervalValue: "1", unit: "hour", total: "1", cron: "" };
}

function rowToInput(row: EditorSchedule): ScheduleInput {
  if (row.kind === "once") return { kind: "once", at: row.at || null };
  if (row.kind === "interval") {
    const seconds = Math.round(Number(row.intervalValue) * INTERVAL_UNIT_SECONDS[row.unit]);
    return { kind: "interval", startAt: row.startAt || null, intervalSeconds: seconds, total: Number(row.total) };
  }
  return { kind: "cron", cron: row.cron.trim() };
}

function rowFromCard(s: ScheduleCard): EditorSchedule {
  const row = emptyRow();
  row.kind = s.kind;
  row.at = toLocalInput(s.at);
  row.startAt = toLocalInput(s.startAt);
  if (s.kind === "interval" && s.intervalSeconds) {
    const { value, unit } = intervalToValueUnit(s.intervalSeconds);
    row.intervalValue = String(value);
    row.unit = unit;
    row.total = String(s.total ?? 1);
  }
  if (s.kind === "cron") row.cron = s.cron ?? "";
  return row;
}

function validateRows(rows: EditorSchedule[]): string | null {
  for (const row of rows) {
    if (row.kind === "once") {
      if (!row.at) return "单次计划缺少时间：请选择具体日期和时间";
      if (Number.isNaN(new Date(row.at).getTime())) return "单次计划的时间无效";
    } else if (row.kind === "interval") {
      if (!row.startAt) return "间隔计划缺少开始时间";
      const value = Number(row.intervalValue);
      if (!Number.isFinite(value) || value <= 0) return "间隔计划的间隔时长须为正数";
      const total = Number(row.total);
      if (!Number.isInteger(total) || total < 1) return "间隔计划的次数须为至少 1 次的整数";
    } else {
      const parsed = parseCron(row.cron);
      if (!parsed.ok) return `cron 计划无效：${parsed.error}`;
    }
  }
  return null;
}

/** cron 实时预览：解析 + 未来 5 次触发（本地时间）。 */
function CronPreview({ expr }: { expr: string }) {
  const preview = useMemo(() => {
    const trimmed = expr.trim();
    if (trimmed === "") return { error: "", fires: [] as Date[] };
    const parsed = parseCron(trimmed);
    if (!parsed.ok) return { error: parsed.error, fires: [] as Date[] };
    return { error: "", fires: nextFires(trimmed, new Date(), 5) };
  }, [expr]);
  if (preview.error !== "") {
    return <p className="rem-cron-error" role="alert">cron 表达式无效：{preview.error}</p>;
  }
  if (preview.fires.length === 0) return null;
  return (
    <div className="rem-cron-preview">
      <span className="rem-cron-preview-label">接下来 5 次：</span>
      <ol>
        {preview.fires.map((d, i) => (
          <li key={i}>{fmtLocal(d.toISOString())}</li>
        ))}
      </ol>
    </div>
  );
}

function ScheduleRowEditor({
  row,
  onChange,
  onRemove,
  canRemove,
}: {
  row: EditorSchedule;
  onChange: (next: EditorSchedule) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const patch = (partial: Partial<EditorSchedule>): void => onChange({ ...row, ...partial });
  return (
    <div className="rem-schedule-row" data-kind={row.kind}>
      <div className="rem-schedule-head">
        <div className="rem-kind-radio" role="radiogroup" aria-label="计划类型">
          {(["once", "interval", "cron"] as const).map((k) => (
            <label key={k} className={row.kind === k ? "is-active" : ""}>
              <input
                type="radio"
                name={`kind-${row.key}`}
                value={k}
                checked={row.kind === k}
                onChange={() => patch({ kind: k })}
              />
              {KIND_LABELS[k]}
            </label>
          ))}
        </div>
        <button type="button" className="rem-button rem-button-danger rem-row-remove" onClick={onRemove} disabled={!canRemove}>
          移除
        </button>
      </div>

      {row.kind === "once" && (
        <label className="rem-field">
          <span>提醒时间</span>
          <input type="datetime-local" value={row.at} onChange={(e) => patch({ at: e.target.value })} />
        </label>
      )}

      {row.kind === "interval" && (
        <div className="rem-interval-fields">
          <label className="rem-field">
            <span>开始时间</span>
            <input type="datetime-local" value={row.startAt} onChange={(e) => patch({ startAt: e.target.value })} />
          </label>
          <label className="rem-field rem-field-narrow">
            <span>间隔每</span>
            <input
              type="number"
              min="1"
              step="1"
              value={row.intervalValue}
              onChange={(e) => patch({ intervalValue: e.target.value })}
            />
          </label>
          <label className="rem-field rem-field-narrow">
            <span>单位</span>
            <select value={row.unit} onChange={(e) => patch({ unit: e.target.value as IntervalUnit })}>
              {(Object.keys(INTERVAL_UNIT_SECONDS) as IntervalUnit[]).map((u) => (
                <option key={u} value={u}>{INTERVAL_UNIT_LABELS[u]}</option>
              ))}
            </select>
          </label>
          <label className="rem-field rem-field-narrow">
            <span>次数</span>
            <input type="number" min="1" step="1" value={row.total} onChange={(e) => patch({ total: e.target.value })} />
          </label>
        </div>
      )}

      {row.kind === "cron" && (
        <div className="rem-cron-block">
          <label className="rem-field">
            <span>cron 表达式 <small>分 时 日 月 周（服务器时间）</small></span>
            <input
              type="text"
              value={row.cron}
              placeholder="如 */15 9-17 * * 1-5"
              onChange={(e) => patch({ cron: e.target.value })}
            />
          </label>
          <CronPreview expr={row.cron} />
        </div>
      )}
    </div>
  );
}

// —— 卡片 ——

function scheduleSummaryLines(s: ScheduleCard): string {
  if (s.kind === "once") {
    const state = s.missedAt !== null ? "已错过（未推送）" : s.sent >= 1 ? "已发送" : `下次 ${fmtLocal(s.at)}`;
    return `单次 · ${fmtLocal(s.at)} · ${state}`;
  }
  if (s.kind === "interval") {
    const { value, unit } = intervalToValueUnit(s.intervalSeconds ?? 60);
    const done = s.total !== null && s.sent >= s.total;
    const parts = [
      "间隔",
      `自 ${fmtLocal(s.startAt)} 起`,
      `每 ${value} ${INTERVAL_UNIT_LABELS[unit]}`,
      `共 ${s.total ?? "?"} 次（已发 ${s.sent}）`,
    ];
    if (done) parts.push("已完成");
    else if (s.nextAt) parts.push(`下次 ${fmtLocal(s.nextAt)}`);
    return parts.join(" · ");
  }
  const next = s.nextAt ? `下次 ${fmtLocal(s.nextAt)}` : "无未来触发";
  return `cron · ${s.cron ?? ""} · ${next}`;
}

function ReminderCardView({
  card,
  busy,
  onEdit,
  onToggle,
  onDelete,
  onTest,
  testFeedback,
}: {
  card: ReminderCard;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onTest: () => void;
  testFeedback: { ok: boolean; text: string } | null;
}) {
  return (
    <article className={`rem-card ${card.enabled ? "" : "is-paused"}`}>
      <div className="rem-card-head">
        <span className={`rem-badge is-${card.status}`}>{STATUS_LABELS[card.status]}</span>
        <span className="rem-card-next">{card.nextAt ? `下次 ${fmtLocal(card.nextAt)}` : "无待触发"}</span>
      </div>
      <p className="rem-card-text">{card.text}</p>
      {card.images.length > 0 && (
        <div className="rem-card-images">
          {card.images.map((img) => (
            <a
              key={img.id}
              href={attachmentUrl(card.id, img.storedName)}
              target="_blank"
              rel="noreferrer"
              title={`${img.originalName}（${fmtBytes(img.size)}）`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={attachmentUrl(card.id, img.storedName)} alt={img.originalName} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      <ul className="rem-card-schedules">
        {card.schedules.map((s) => (
          <li key={s.id} className={s.enabled ? "" : "is-disabled-schedule"}>{scheduleSummaryLines(s)}</li>
        ))}
        {card.schedules.length === 0 && <li className="rem-muted">没有时间计划（仅可通过测试发送）</li>}
      </ul>
      {testFeedback && (
        <p className={`rem-feedback is-${testFeedback.ok ? "ok" : "error"}`} role="status">{testFeedback.text}</p>
      )}
      <div className="rem-card-actions">
        <button type="button" className="rem-button rem-button-secondary" onClick={onEdit} disabled={busy}>编辑</button>
        <button type="button" className="rem-button rem-button-secondary" onClick={onToggle} disabled={busy}>
          {card.enabled ? "暂停" : "启用"}
        </button>
        <button type="button" className="rem-button rem-button-secondary" onClick={onTest} disabled={busy}>立即测试</button>
        <button type="button" className="rem-button rem-button-danger" onClick={onDelete} disabled={busy}>删除</button>
      </div>
      <p className="rem-muted">测试与推送走全局推送渠道：<a href="/channels">配置 Bark / 飞书 / Telegram →</a></p>
    </article>
  );
}

// —— 主组件 ——

export function RemindersClient({ initialReminders }: { initialReminders: ReminderCard[] }) {
  const router = useRouter();
  const [reminders, setReminders] = useState<ReminderCard[]>(initialReminders);
  useEffect(() => {
    setReminders(initialReminders);
  }, [initialReminders]);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [text, setText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [rows, setRows] = useState<EditorSchedule[]>([emptyRow()]);
  const [existingImages, setExistingImages] = useState<ImageCard[]>([]);
  const [staged, setStaged] = useState<StagedImage[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [testFeedback, setTestFeedback] = useState<{ id: number; ok: boolean; text: string } | null>(null);
  const [pending, startPending] = useTransition();
  const [saving, startSave] = useTransition();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 卸载时释放预览对象 URL。
  useEffect(() => {
    return () => {
      for (const s of staged) URL.revokeObjectURL(s.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = (): void => {
    setEditingId(null);
    setText("");
    setEnabled(true);
    setRows([emptyRow()]);
    setExistingImages([]);
    setStaged((prev) => {
      for (const s of prev) URL.revokeObjectURL(s.url);
      return [];
    });
    setMessage(null);
    setEditorOpen(true);
  };

  const openEdit = (card: ReminderCard): void => {
    setEditingId(card.id);
    setText(card.text);
    setEnabled(card.enabled);
    setRows(card.schedules.length > 0 ? card.schedules.map(rowFromCard) : [emptyRow()]);
    setExistingImages(card.images);
    setStaged((prev) => {
      for (const s of prev) URL.revokeObjectURL(s.url);
      return [];
    });
    setMessage(null);
    setEditorOpen(true);
  };

  const closeEditor = (): void => {
    setEditorOpen(false);
    setEditingId(null);
    setStaged((prev) => {
      for (const s of prev) URL.revokeObjectURL(s.url);
      return [];
    });
  };

  const addFiles = (files: FileList | null): void => {
    if (!files || files.length === 0) return;
    const errors: string[] = [];
    const accepted: StagedImage[] = [];
    for (const file of Array.from(files)) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        errors.push(`「${file.name}」格式不支持（仅支持 JPEG/PNG/WebP）`);
        continue;
      }
      if (file.size > REMINDERS_MAX_IMAGE_BYTES) {
        errors.push(`「${file.name}」超过 10MB`);
        continue;
      }
      accepted.push({ key: nextRowKey(), file, url: URL.createObjectURL(file) });
    }
    const allowed = REMINDERS_MAX_IMAGES - existingImages.length - staged.length;
    if (allowed <= 0) {
      errors.unshift(`每条提醒最多 ${REMINDERS_MAX_IMAGES} 张图片`);
      for (const s of accepted) URL.revokeObjectURL(s.url);
      accepted.length = 0;
    } else if (accepted.length > allowed) {
      errors.unshift(`每条提醒最多 ${REMINDERS_MAX_IMAGES} 张图片`);
      for (const s of accepted.slice(allowed)) URL.revokeObjectURL(s.url);
      accepted.length = allowed;
    }
    setStaged((prev) => [...prev, ...accepted]);
    if (errors.length > 0) setMessage({ tone: "error", text: errors.join("；") });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeStaged = (key: string): void => {
    setStaged((prev) => {
      const target = prev.find((s) => s.key === key);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((s) => s.key !== key);
    });
  };

  const save = (): void => {
    setMessage(null);
    if (text.trim() === "") {
      setMessage({ tone: "error", text: "提醒文字不能为空" });
      return;
    }
    if (text.trim().length > REMINDERS_MAX_TEXT_LENGTH) {
      setMessage({ tone: "error", text: `提醒文字不能超过 ${REMINDERS_MAX_TEXT_LENGTH} 字` });
      return;
    }
    if (rows.length === 0) {
      setMessage({ tone: "error", text: "至少需要一条时间计划" });
      return;
    }
    const rowError = validateRows(rows);
    if (rowError) {
      setMessage({ tone: "error", text: rowError });
      return;
    }
    const payload: SaveReminderPayload = {
      ...(editingId !== null ? { id: editingId } : {}),
      text: text.trim(),
      enabled,
      schedules: rows.map(rowToInput),
    };
    const fd = new FormData();
    for (const s of staged) fd.append("images", s.file);
    startSave(async () => {
      const res = await saveReminderAction(payload, fd);
      if (res.ok) {
        closeEditor();
        setMessage({ tone: "ok", text: editingId !== null ? "提醒已保存。" : "提醒已创建。" });
        router.refresh();
      } else {
        setMessage({ tone: "error", text: res.error });
      }
    });
  };

  const withBusy = (id: number, run: () => Promise<void>): void => {
    setBusyId(id);
    startPending(async () => {
      try {
        await run();
      } finally {
        setBusyId(null);
      }
    });
  };

  const toggle = (card: ReminderCard): void => {
    setMessage(null);
    withBusy(card.id, async () => {
      const res = await setReminderEnabledAction(card.id, !card.enabled);
      if (res.ok) {
        setMessage({ tone: "ok", text: res.ok && !card.enabled ? "提醒已启用。" : "提醒已暂停。" });
        router.refresh();
      } else {
        setMessage({ tone: "error", text: res.error });
      }
    });
  };

  const remove = (card: ReminderCard): void => {
    const confirmText =
      card.images.length > 0
        ? `确定删除这条提醒？文字、${card.schedules.length} 条时间计划与 ${card.images.length} 张图片会一并删除。`
        : "确定删除这条提醒？相关的时间计划会一并删除。";
    if (!window.confirm(confirmText)) return;
    setMessage(null);
    withBusy(card.id, async () => {
      const res = await deleteReminderAction(card.id);
      if (res.ok) {
        setTestFeedback((prev) => (prev?.id === card.id ? null : prev));
        setMessage({ tone: "ok", text: "提醒已删除。" });
        router.refresh();
      } else {
        setMessage({ tone: "error", text: res.error });
      }
    });
  };

  const test = (card: ReminderCard): void => {
    setMessage(null);
    setTestFeedback({ id: card.id, ok: true, text: "测试发送中…" });
    withBusy(card.id, async () => {
      const res = await testReminderAction(card.id);
      if (res.ok) {
        const lines = res.channels.map((c) => `${c.name}：${c.status}${c.error ? `（${c.error}）` : ""}`).join("；");
        setTestFeedback({
          id: card.id,
          ok: res.aggregate !== "失败",
          text: `测试结果：${res.aggregate}${lines ? `\n${lines}` : ""}`,
        });
      } else {
        setTestFeedback({ id: card.id, ok: false, text: res.error });
      }
    });
  };

  const removeExistingImage = (cardId: number, imageId: number): void => {
    if (!window.confirm("确定删除这张图片？删除后不可恢复。")) return;
    setMessage(null);
    withBusy(cardId, async () => {
      const res = await deleteReminderImageAction(cardId, imageId);
      if (res.ok) {
        setExistingImages((prev) => prev.filter((img) => img.id !== imageId));
        router.refresh();
      } else {
        setMessage({ tone: "error", text: res.error });
      }
    });
  };

  const busy = pending || saving;
  const totalPending = reminders.filter((r) => r.enabled && r.nextAt !== null).length;

  return (
    <div className="rem-root">
      <header className="rem-hero">
        <div>
          <p className="rem-kicker">REMINDERS</p>
          <h1 className="rem-title">提醒事项</h1>
          <p className="rem-sub">文字与图片提醒：一条提醒可叠加多个时间计划 —— 单次、间隔重复与 cron 定时，经 Bark / 飞书 / Telegram 推送。</p>
        </div>
        <div className="rem-hero-side">
          <span className="rem-stat">{totalPending} 条待触发</span>
          <button type="button" className="rem-button rem-button-primary" onClick={openCreate} disabled={busy}>
            + 新建提醒
          </button>
        </div>
      </header>

      {message && <p className={`rem-feedback is-${message.tone}`} role="status">{message.text}</p>}

      {editorOpen && (
        <section className="rem-editor" aria-label={editingId !== null ? "编辑提醒" : "新建提醒"}>
          <div className="rem-editor-head">
            <h2>{editingId !== null ? "编辑提醒" : "新建提醒"}</h2>
            <button type="button" className="rem-button rem-button-secondary" onClick={closeEditor} disabled={busy}>关闭</button>
          </div>

          <label className="rem-field">
            <span>提醒文字</span>
            <textarea
              value={text}
              rows={3}
              maxLength={REMINDERS_MAX_TEXT_LENGTH}
              placeholder="如：缴房租 / 吃药 / 站起来活动一下"
              onChange={(e) => setText(e.target.value)}
            />
          </label>

          <div className="rem-editor-images">
            <p className="rem-editor-label">图片（可选，最多 {REMINDERS_MAX_IMAGES} 张，单张 ≤10MB，JPEG/PNG/WebP）</p>
            <div className="rem-image-grid">
              {existingImages.map((img) => (
                <figure key={img.id} className="rem-image-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={attachmentUrl(editingId ?? 0, img.storedName)} alt={img.originalName} />
                  <button
                    type="button"
                    className="rem-image-remove"
                    aria-label={`删除图片 ${img.originalName}`}
                    onClick={() => editingId !== null && removeExistingImage(editingId, img.id)}
                    disabled={busy}
                  >
                    ×
                  </button>
                </figure>
              ))}
              {staged.map((s) => (
                <figure key={s.key} className="rem-image-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.url} alt={s.file.name} />
                  <button type="button" className="rem-image-remove" aria-label={`移除图片 ${s.file.name}`} onClick={() => removeStaged(s.key)}>
                    ×
                  </button>
                </figure>
              ))}
              <button
                type="button"
                className="rem-image-add"
                onClick={() => fileInputRef.current?.click()}
                disabled={existingImages.length + staged.length >= REMINDERS_MAX_IMAGES}
              >
                + 添加图片
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              hidden
              onChange={(e) => addFiles(e.target.files)}
            />
          </div>

          <div className="rem-editor-schedules">
            <p className="rem-editor-label">时间计划（可叠加多条；单次 / 间隔 / cron 可混用）</p>
            {rows.map((row) => (
              <ScheduleRowEditor
                key={row.key}
                row={row}
                canRemove={rows.length > 1}
                onChange={(next) => setRows((prev) => prev.map((r) => (r.key === row.key ? next : r)))}
                onRemove={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
              />
            ))}
            <button type="button" className="rem-button rem-button-secondary" onClick={() => setRows((prev) => [...prev, emptyRow()])}>
              + 添加时间计划
            </button>
          </div>

          <div className="rem-editor-footer">
            <label className="rem-enabled-toggle">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              启用这条提醒
            </label>
            <div className="rem-actions">
              <button type="button" className="rem-button rem-button-secondary" onClick={closeEditor} disabled={busy}>取消</button>
              <button type="button" className="rem-button rem-button-primary" onClick={save} disabled={busy}>
                {saving ? "保存中…" : "保存提醒"}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="rem-list" aria-label="提醒列表">
        {reminders.length === 0 ? (
          <p className="rem-empty">还没有提醒。点击「新建提醒」创建第一条：支持单次、间隔重复与 cron 定时，可附图片。推送前请先在<a href="/channels">全局推送渠道</a>配置 Bark / 飞书 / Telegram。</p>
        ) : (
          reminders.map((card) => (
            <ReminderCardView
              key={card.id}
              card={card}
              busy={busy || busyId === card.id}
              onEdit={() => openEdit(card)}
              onToggle={() => toggle(card)}
              onDelete={() => remove(card)}
              onTest={() => test(card)}
              testFeedback={testFeedback?.id === card.id ? { ok: testFeedback.ok, text: testFeedback.text } : null}
            />
          ))
        )}
      </section>
    </div>
  );
}

export default RemindersClient;
