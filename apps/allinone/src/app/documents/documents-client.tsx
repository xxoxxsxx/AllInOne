"use client";

// 证件夹客户端 UI：筛选/排序、卡片网格、新建/编辑表单、详情抽屉（附件+灯箱）、分类持有人标签管理。
// 数据变更全部走 Server Actions，成功后 router.refresh() 重新下发最新列表。
// Overlay 规则：同一时刻只渲染一个主 overlay（表单弹窗 / 详情抽屉互斥，关闭表单回到抽屉），
// 灯箱是抽屉之上的唯一叠加层；Escape / 焦点圈定 / 滚动锁统一由 useOverlayDialog 管理。

import { useEffect, useMemo, useRef, useState, type FormEvent, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";

import {
  MAX_FILES_PER_DOCUMENT,
  STATUS_LABELS,
  addDuration,
  maskNumber,
  type DocStatus,
} from "@/lib/documents/constants";
import type { Category, DocumentRecord, DurationUnit, Holder, DocTag } from "@/lib/documents/db";

import {
  createCategoryAction,
  createHolderAction,
  deleteCategoryAction,
  deleteDocumentAction,
  deleteFileAction,
  deleteHolderAction,
  deleteTagAction,
  renameCategoryAction,
  renameHolderAction,
  reorderDocumentsAction,
  saveDocumentAction,
  uploadFilesAction,
} from "./actions";

import { useOverlayDialog } from "./use-overlay-dialog";

type SortMode = "custom" | "expiry" | "created";

type FormState = {
  title: string;
  holderId: number | null;
  categoryId: number | null;
  number: string;
  issuer: string;
  startDate: string;
  expiryType: "date" | "duration";
  expiryDate: string;
  durationValue: string;
  durationUnit: DurationUnit;
  note: string;
  tags: string;
};

const EMPTY_FORM: FormState = {
  title: "",
  holderId: null,
  categoryId: null,
  number: "",
  issuer: "",
  startDate: "",
  expiryType: "date",
  expiryDate: "",
  durationValue: "",
  durationUnit: "year",
  note: "",
  tags: "",
};

// —— 附件客户端校验（与服务端 files.ts 的限额保持一致，不做静默截断） ——

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 单文件 10MB
export const MAX_BATCH_BYTES = 30 * 1024 * 1024; // 单次上传合计 30MB
const ALLOWED_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

function fileAllowed(file: File): boolean {
  if (ALLOWED_MIMES.has(file.type)) return true;
  return /\.(jpe?g|png|webp|pdf)$/i.test(file.name);
}

/** 返回错误文案；null 表示通过。绝不静默截断列表。 */
export function validateFiles(list: File[], existingCount: number): string | null {
  if (list.length === 0) return null;
  if (existingCount + list.length > MAX_FILES_PER_DOCUMENT) {
    return `每份证件最多 ${MAX_FILES_PER_DOCUMENT} 个附件（该证件已有 ${existingCount} 个，本次选择了 ${list.length} 个）`;
  }
  for (const f of list) {
    if (!fileAllowed(f)) return `不支持的文件类型：${f.name}（仅支持 JPEG / PNG / WebP 图片与 PDF）`;
    if (f.size > MAX_FILE_BYTES) return `「${f.name}」超过 ${MAX_FILE_BYTES / 1024 / 1024}MB，请压缩后再上传`;
  }
  const total = list.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_BATCH_BYTES) {
    return `一次上传的文件总大小不能超过 ${MAX_BATCH_BYTES / 1024 / 1024}MB（本次约 ${(total / 1024 / 1024).toFixed(1)}MB），请分批上传`;
  }
  return null;
}

function formFromDoc(doc: DocumentRecord): FormState {
  return {
    title: doc.title,
    holderId: doc.holderId,
    categoryId: doc.categoryId,
    number: doc.number,
    issuer: doc.issuer,
    startDate: doc.startDate,
    expiryType: doc.durationValue !== null && doc.durationUnit !== null ? "duration" : "date",
    expiryDate: doc.expiryDate,
    durationValue: doc.durationValue !== null ? String(doc.durationValue) : "",
    durationUnit: doc.durationUnit ?? "year",
    note: doc.note,
    tags: doc.tags.map((t) => t.name).join("、"),
  };
}

function parseTags(raw: string): string[] {
  return raw.split(/[，,、\s]+/).map((s) => s.trim()).filter(Boolean);
}

function daysText(doc: DocumentRecord): string {
  if (!doc.expiryDate) return "长期有效";
  if (doc.daysLeft === null) return doc.expiryDate;
  if (doc.daysLeft < 0) return `已过期 ${-doc.daysLeft} 天`;
  if (doc.daysLeft === 0) return "今天到期";
  return `剩余 ${doc.daysLeft} 天`;
}

function formatDateCn(value: string): string {
  if (!value) return "—";
  return value;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const CATEGORY_EMOJIS: Array<[RegExp, string]> = [
  [/护照/, "🛂"],
  [/签证/, "🧳"],
  [/身份证/, "🪪"],
  [/驾照|行驶/, "🚗"],
  [/社保|医保/, "🏥"],
  [/保单|保险/, "🛡️"],
  [/合同|协议/, "📄"],
];

function categoryEmoji(name: string | null): string {
  if (!name) return "🗂️";
  for (const [re, emoji] of CATEGORY_EMOJIS) {
    if (re.test(name)) return emoji;
  }
  return "🗂️";
}

function fileUrl(file: string): string {
  return `/api/documents/files/${file}`;
}

// —— 到期进度环：进度直接由 daysLeft 推导，不再依赖 todayStr 的时区解析 ——

function DaysRing({ doc }: { doc: DocumentRecord }) {
  if (!doc.expiryDate || doc.daysLeft === null) return null;
  const r = 15;
  const c = 2 * Math.PI * r;
  let frac: number;
  if (doc.startDate && doc.startDate < doc.expiryDate) {
    const totalDays = Math.round((Date.parse(doc.expiryDate) - Date.parse(doc.startDate)) / 86_400_000);
    frac = totalDays > 0 ? doc.daysLeft / totalDays : 0;
  } else {
    frac = doc.daysLeft / 365;
  }
  frac = Math.min(1, Math.max(0, frac));
  const color =
    doc.status === "expired"
      ? "var(--danger)"
      : doc.status === "expiring"
        ? "var(--warn)"
        : doc.status === "upcoming"
          ? "var(--docs-teal)"
          : "var(--ok)";
  return (
    <svg className="docs-ring" viewBox="0 0 40 40" width={44} height={44} role="img" aria-label={`${STATUS_LABELS[doc.status]}${doc.expiryDate ? `，${daysText(doc)}` : ""}`}>
      <circle cx="20" cy="20" r={r} fill="none" stroke="var(--border)" strokeWidth="3.5" />
      <circle
        cx="20"
        cy="20"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray={`${(c * frac).toFixed(2)} ${c.toFixed(2)}`}
        transform="rotate(-90 20 20)"
      />
      <text x="20" y="24" textAnchor="middle" fontSize="10" fill={color} fontWeight="700">
        {doc.daysLeft >= 0 && doc.daysLeft <= 999 ? doc.daysLeft : "···"}
      </text>
    </svg>
  );
}

// —— 表单弹窗 ——

function FormModal(props: {
  doc: DocumentRecord | null;
  /** 续签/复制预填：doc 为空但 initial 有值时按 create 保存。 */
  initial?: FormState | null;
  heading?: string;
  holders: Holder[];
  categories: Category[];
  allTags: DocTag[];
  onClose: () => void;
  onSaved: (id: number) => void;
}) {
  const { doc, initial, heading, holders, categories, allTags, onClose, onSaved } = props;
  const [form, setForm] = useState<FormState>(() => initial ?? (doc ? formFromDoc(doc) : EMPTY_FORM));
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newHolder, setNewHolder] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 首次保存成功后记录 id：附件上传失败重试时走更新而不是再创建（避免重复记录）。
  const savedIdRef = useRef<number | null>(null);
  const { overlayRef, requestClose, onBackdropMouseDown } = useOverlayDialog(onClose, busy);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const durationPreview = useMemo(() => {
    if (form.expiryType !== "duration") return null;
    const value = Number(form.durationValue);
    if (!Number.isSafeInteger(value) || value <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(form.startDate)) return null;
    try {
      return addDuration(form.startDate, value, form.durationUnit);
    } catch {
      return null;
    }
  }, [form.expiryType, form.durationValue, form.durationUnit, form.startDate]);

  // 日期模式安全切换：切回「直接到期日」时若到期日为空，用已计算的时长结果回填，避免丢数据。
  function switchExpiryType(next: "date" | "duration") {
    if (next === form.expiryType) return;
    if (next === "date") {
      setForm((f) => ({ ...f, expiryType: "date", expiryDate: f.expiryDate || durationPreview || "" }));
      return;
    }
    setForm((f) => ({ ...f, expiryType: "duration" }));
  }

  function onFilesPicked(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const list = Array.from(input.files ?? []);
    const problem = validateFiles(list, 0);
    if (problem) {
      setError(problem);
      setFiles([]);
      input.value = "";
      return;
    }
    setError("");
    setFiles(list);
  }

  async function ensureHolder(): Promise<number | null> {
    if (newHolder === null) return form.holderId;
    const name = newHolder.trim();
    if (!name) return null;
    const res = await createHolderAction(name);
    if (!res.ok) throw new Error(res.error);
    setNewHolder(null);
    // 新建持有人/分类成功后立即回写表单：即使后续保存失败重试，ID 也不会丢失。
    setForm((f) => ({ ...f, holderId: res.id }));
    return res.id;
  }

  async function ensureCategory(): Promise<number | null> {
    if (newCategory === null) return form.categoryId;
    const name = newCategory.trim();
    if (!name) return null;
    const res = await createCategoryAction(name);
    if (!res.ok) throw new Error(res.error);
    setNewCategory(null);
    setForm((f) => ({ ...f, categoryId: res.id }));
    return res.id;
  }

  async function submit() {
    if (busy) return;
    setError("");
    if (!form.title.trim()) {
      setError("请填写证件名称");
      return;
    }
    if (form.expiryType === "duration") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(form.startDate)) {
        setError("按时长录入需要填写开始日期");
        return;
      }
      const value = Number(form.durationValue);
      if (!Number.isSafeInteger(value) || value <= 0) {
        setError("请填写有效的时长（正整数）");
        return;
      }
    }
    const fileProblem = validateFiles(files, 0);
    if (fileProblem) {
      setError(fileProblem);
      return;
    }
    setBusy(true);
    try {
      const holderId = await ensureHolder();
      const categoryId = await ensureCategory();
      const res = await saveDocumentAction({
        // 重试时带上首次保存返回的 id，走更新路径，避免重复创建记录。
        id: savedIdRef.current ?? doc?.id,
        title: form.title,
        holderId,
        categoryId,
        number: form.number,
        issuer: form.issuer,
        startDate: form.startDate,
        expiryType: form.expiryType,
        expiryDate: form.expiryDate,
        durationValue: form.expiryType === "duration" ? Number(form.durationValue) : undefined,
        durationUnit: form.expiryType === "duration" ? form.durationUnit : undefined,
        note: form.note,
        tags: parseTags(form.tags),
      });
      if (!res.ok) throw new Error(res.error);
      savedIdRef.current = res.id;
      if (files.length > 0) {
        const fd = new FormData();
        for (const f of files) fd.append("files", f);
        const up = await uploadFilesAction(res.id, fd);
        if (!up.ok) throw new Error(`证件已保存，但附件上传失败：${up.error}。修正后可直接重试，不会重复创建证件。`);
      }
      onSaved(res.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void submit();
  }

  return (
    <div
      ref={overlayRef}
      className="docs-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={heading ?? (doc ? "编辑证件" : "新增证件")}
      tabIndex={-1}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="docs-modal">
        <header className="docs-modal-head">
          <h2>{heading ?? (doc ? "编辑证件" : "新增证件")}</h2>
          <button type="button" className="docs-icon-btn" onClick={requestClose} aria-label="关闭" disabled={busy}>✕</button>
        </header>
        <form className="docs-form" onSubmit={onSubmit} noValidate>
          <div className="docs-modal-body">
            <label className="docs-field">
              <span className="docs-label">名称 *</span>
              <input value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={100} placeholder="如：护照 / 日本签证" autoFocus />
            </label>
            <div className="docs-field-row">
              <label className="docs-field">
                <span className="docs-label">持有人</span>
                {newHolder === null ? (
                  <select
                    value={form.holderId ?? 0}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (v === -1) setNewHolder("");
                      else set("holderId", v || null);
                    }}
                  >
                    <option value={0}>未指定</option>
                    {holders.map((h) => (
                      <option key={h.id} value={h.id}>{h.name}</option>
                    ))}
                    <option value={-1}>＋ 新增持有人…</option>
                  </select>
                ) : (
                  <span className="docs-inline-new">
                    <input value={newHolder} onChange={(e) => setNewHolder(e.target.value)} maxLength={40} placeholder="持有人姓名" />
                    <button type="button" className="docs-mini-btn" onClick={() => setNewHolder(null)}>取消</button>
                  </span>
                )}
              </label>
              <label className="docs-field">
                <span className="docs-label">分类</span>
                {newCategory === null ? (
                  <select
                    value={form.categoryId ?? 0}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (v === -1) setNewCategory("");
                      else set("categoryId", v || null);
                    }}
                  >
                    <option value={0}>未分类</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                    <option value={-1}>＋ 新增分类…</option>
                  </select>
                ) : (
                  <span className="docs-inline-new">
                    <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} maxLength={40} placeholder="分类名称" />
                    <button type="button" className="docs-mini-btn" onClick={() => setNewCategory(null)}>取消</button>
                  </span>
                )}
              </label>
            </div>
            <div className="docs-field-row">
              <label className="docs-field">
                <span className="docs-label">证件号码</span>
                <input value={form.number} onChange={(e) => set("number", e.target.value)} maxLength={64} placeholder="页面中默认打码显示" />
              </label>
              <label className="docs-field">
                <span className="docs-label">签发机关</span>
                <input value={form.issuer} onChange={(e) => set("issuer", e.target.value)} maxLength={100} placeholder="如：出入境管理局" />
              </label>
            </div>
            <fieldset className="docs-fieldset">
              <legend className="docs-label">有效期</legend>
              <div className="docs-radio-row" role="radiogroup" aria-label="有效期方式">
                <label className="docs-radio">
                  <input type="radio" name="expiryType" checked={form.expiryType === "date"} onChange={() => switchExpiryType("date")} />
                  直接到期日
                </label>
                <label className="docs-radio">
                  <input type="radio" name="expiryType" checked={form.expiryType === "duration"} onChange={() => switchExpiryType("duration")} />
                  开始日期 + 时长
                </label>
              </div>
              {form.expiryType === "date" ? (
                <div className="docs-field-row">
                  <label className="docs-field">
                    <span className="docs-label">开始日期</span>
                    <input type="date" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />
                  </label>
                  <label className="docs-field">
                    <span className="docs-label">失效时间（留空 = 长期）</span>
                    <input type="date" value={form.expiryDate} onChange={(e) => set("expiryDate", e.target.value)} />
                  </label>
                </div>
              ) : (
                <>
                  <div className="docs-field-row">
                    <label className="docs-field">
                      <span className="docs-label">开始日期 *</span>
                      <input type="date" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />
                    </label>
                    <label className="docs-field">
                      <span className="docs-label">时长 *</span>
                      <span className="docs-duration">
                        <input
                          type="number"
                          min={1}
                          value={form.durationValue}
                          onChange={(e) => set("durationValue", e.target.value)}
                          placeholder="如 5"
                        />
                        <select value={form.durationUnit} onChange={(e) => set("durationUnit", e.target.value as DurationUnit)}>
                          <option value="day">天</option>
                          <option value="month">月</option>
                          <option value="year">年</option>
                        </select>
                      </span>
                    </label>
                  </div>
                  {durationPreview ? <p className="docs-hint">到期日自动计算：{durationPreview}</p> : null}
                </>
              )}
            </fieldset>
            <label className="docs-field">
              <span className="docs-label">标签（用空格或顿号分隔）</span>
              <input
                value={form.tags}
                onChange={(e) => set("tags", e.target.value)}
                maxLength={400}
                placeholder="如：出行 常用"
                list="docs-tag-options"
              />
              <datalist id="docs-tag-options">
                {allTags.map((t) => (
                  <option key={t.id} value={t.name} />
                ))}
              </datalist>
            </label>
            <label className="docs-field">
              <span className="docs-label">备注</span>
              <textarea value={form.note} onChange={(e) => set("note", e.target.value)} maxLength={2000} rows={3} placeholder="保管地点、注意事项等" />
            </label>
            {!doc ? (
              <label className="docs-field">
                <span className="docs-label">附件 / 照片（可选，保存后也可继续添加）</span>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={onFilesPicked}
                />
                <span className="docs-hint">
                  支持 JPEG / PNG / WebP 图片与 PDF；单个文件不超过 10MB，一次不超过 30MB，每份证件最多 {MAX_FILES_PER_DOCUMENT} 个附件。
                </span>
              </label>
            ) : null}
            {error ? <p className="docs-error" role="alert">{error}</p> : null}
          </div>
          <footer className="docs-modal-foot">
            <button type="button" className="docs-btn" onClick={requestClose} disabled={busy}>取消</button>
            <button type="submit" className="docs-btn docs-btn-primary" disabled={busy || !form.title.trim()}>
              {busy ? "保存中…" : "保存"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

// —— 详情抽屉 ——

function DetailDrawer(props: {
  doc: DocumentRecord;
  onClose: () => void;
  onEdit: () => void;
  onRenew: () => void;
  onLightbox: (index: number) => void;
}) {
  const { doc, onClose, onEdit, onRenew, onLightbox } = props;
  const router = useRouter();
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { overlayRef, requestClose, onBackdropMouseDown } = useOverlayDialog(onClose, busy);
  const images = doc.files.filter((f) => f.isImage);

  async function upload(input: HTMLInputElement) {
    const list = Array.from(input.files ?? []);
    if (list.length === 0) return;
    const problem = validateFiles(list, doc.files.length);
    if (problem) {
      setError(problem);
      input.value = "";
      return;
    }
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      for (const f of list) fd.append("files", f);
      const res = await uploadFilesAction(doc.id, fd);
      if (!res.ok) throw new Error(res.error);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function removeFile(fileId: number) {
    if (!window.confirm("确定删除这个附件吗？")) return;
    setBusy(true);
    setError("");
    try {
      const res = await deleteFileAction(fileId);
      if (!res.ok) throw new Error(res.error);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function removeDoc() {
    if (!window.confirm(`确定删除「${doc.title}」吗？其附件也会一并删除。`)) return;
    setBusy(true);
    setError("");
    try {
      const res = await deleteDocumentAction(doc.id);
      if (!res.ok) throw new Error(res.error);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      className="docs-overlay docs-overlay-right"
      role="dialog"
      aria-modal="true"
      aria-label={doc.title}
      tabIndex={-1}
      onMouseDown={onBackdropMouseDown}
    >
      <aside className="docs-drawer">
        <header className="docs-drawer-head">
          <div className="docs-drawer-title">
            <span className="docs-drawer-emoji" aria-hidden>{categoryEmoji(doc.categoryName)}</span>
            <h2>{doc.title}</h2>
            <span className={`docs-status docs-status-${doc.status}`}>{STATUS_LABELS[doc.status]}</span>
          </div>
          <button type="button" className="docs-icon-btn" onClick={requestClose} aria-label="关闭" disabled={busy}>✕</button>
        </header>
        <div className="docs-drawer-body">
          <div className="docs-facts">
            <div className="docs-fact"><span>持有人</span><strong>{doc.holderName ?? "未指定"}</strong></div>
            <div className="docs-fact"><span>分类</span><strong>{doc.categoryName ?? "未分类"}</strong></div>
            <div className="docs-fact">
              <span>证件号码</span>
              <strong className="docs-number">
                {doc.number ? (reveal ? doc.number : maskNumber(doc.number)) : "—"}
                {doc.number ? (
                  <button type="button" className="docs-mini-btn" onClick={() => setReveal((v) => !v)}>
                    {reveal ? "隐藏" : "显示"}
                  </button>
                ) : null}
              </strong>
            </div>
            <div className="docs-fact"><span>签发机关</span><strong>{doc.issuer || "—"}</strong></div>
            <div className="docs-fact"><span>开始日期</span><strong>{formatDateCn(doc.startDate)}</strong></div>
            <div className="docs-fact">
              <span>失效时间</span>
              <strong>
                {doc.expiryDate ? `${formatDateCn(doc.expiryDate)}（${daysText(doc)}）` : "长期有效"}
              </strong>
            </div>
          </div>
          {doc.durationValue !== null && doc.durationUnit !== null ? (
            <p className="docs-hint">
              按时长录入：{doc.durationValue} {doc.durationUnit === "day" ? "天" : doc.durationUnit === "month" ? "月" : "年"}
            </p>
          ) : null}
          {doc.tags.length > 0 ? (
            <div className="docs-tags">
              {doc.tags.map((t) => (
                <span key={t.id} className="docs-tag">{t.name}</span>
              ))}
            </div>
          ) : null}
          {doc.note ? <p className="docs-note">{doc.note}</p> : null}

          <section className="docs-files">
            <div className="docs-files-head">
              <h3>附件（{doc.files.length}/{MAX_FILES_PER_DOCUMENT}）</h3>
              <label className={`docs-btn docs-btn-small${busy || doc.files.length >= MAX_FILES_PER_DOCUMENT ? " docs-btn-disabled" : ""}`}>
                ＋ 添加附件
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  hidden
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  disabled={busy || doc.files.length >= MAX_FILES_PER_DOCUMENT}
                  onChange={(e) => upload(e.currentTarget)}
                />
              </label>
            </div>
            <p className="docs-hint">单个文件 ≤ 10MB，一次合计 ≤ 30MB，每份证件最多 {MAX_FILES_PER_DOCUMENT} 个。</p>
            {doc.files.length === 0 ? (
              <p className="docs-hint">还没有附件。可以上传扫描件、照片或 PDF。</p>
            ) : (
              <div className="docs-file-grid">
                {doc.files.map((f) =>
                  f.isImage ? (
                    <div key={f.id} className="docs-file-item">
                      <button
                        type="button"
                        className="docs-file-thumb"
                        onClick={() => onLightbox(images.findIndex((img) => img.id === f.id))}
                        aria-label={`查看大图：${f.name || "附件图片"}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={fileUrl(f.file)} alt={f.name || "附件图片"} loading="lazy" />
                      </button>
                      {/* ?download=1 由文件接口返回 attachment + 原始文件名 */}
                      <a
                        className="docs-file-dl"
                        href={`${fileUrl(f.file)}?download=1`}
                        download={f.name || undefined}
                        aria-label={`下载附件：${f.name || "附件图片"}`}
                        title="下载"
                      >
                        ⬇
                      </a>
                      <button
                        type="button"
                        className="docs-file-del"
                        onClick={() => void removeFile(f.id)}
                        aria-label={`删除附件：${f.name || "附件图片"}`}
                        disabled={busy}
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div key={f.id} className="docs-file-pdf">
                      <a href={fileUrl(f.file)} target="_blank" rel="noreferrer" className="docs-file-pdf-link">
                        <span aria-hidden>📕</span>
                        <span className="docs-file-pdf-name">{f.name || "PDF 附件"}</span>
                        <span className="docs-hint">{formatSize(f.size)}</span>
                      </a>
                      <a
                        className="docs-file-dl docs-file-dl-row"
                        href={`${fileUrl(f.file)}?download=1`}
                        download={f.name || undefined}
                        aria-label={`下载附件：${f.name || "PDF 附件"}`}
                        title="下载"
                      >
                        ⬇
                      </a>
                      <button type="button" className="docs-icon-btn" onClick={() => void removeFile(f.id)} aria-label={`删除附件：${f.name || "PDF 附件"}`} disabled={busy}>✕</button>
                    </div>
                  ),
                )}
              </div>
            )}
          </section>
          {error ? <p className="docs-error" role="alert">{error}</p> : null}
        </div>
        <footer className="docs-drawer-foot">
          <button type="button" className="docs-btn docs-btn-danger" onClick={() => void removeDoc()} disabled={busy}>删除证件</button>
          <button type="button" className="docs-btn" onClick={onRenew} disabled={busy}>续签</button>
          <button type="button" className="docs-btn docs-btn-primary" onClick={onEdit} disabled={busy}>编辑</button>
        </footer>
      </aside>
    </div>
  );
}

// —— 灯箱 ——

function Lightbox(props: { images: DocumentRecord["files"]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const { images, index, onClose, onIndex } = props;
  const file = images[index];
  const { overlayRef, onBackdropMouseDown } = useOverlayDialog(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && index < images.length - 1) onIndex(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onIndex, onClose]);
  if (!file) return null;
  return (
    <div
      ref={overlayRef}
      className="docs-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`查看附件 ${index + 1} / ${images.length}`}
      tabIndex={-1}
      onClick={onClose}
      onMouseDown={onBackdropMouseDown}
    >
      <button type="button" className="docs-lightbox-close" aria-label="关闭预览" onClick={(e) => { e.stopPropagation(); onClose(); }}>✕</button>
      {images.length > 1 ? (
        <>
          <button type="button" className="docs-lightbox-nav" aria-label="上一张" disabled={index === 0} onClick={(e) => { e.stopPropagation(); onIndex(index - 1); }}>‹</button>
          <button type="button" className="docs-lightbox-nav docs-lightbox-next" aria-label="下一张" disabled={index === images.length - 1} onClick={(e) => { e.stopPropagation(); onIndex(index + 1); }}>›</button>
          <span className="docs-lightbox-count">{index + 1} / {images.length}</span>
        </>
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={fileUrl(file.file)} alt={file.name || "附件图片"} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

// —— 分类 / 持有人 / 标签 管理 ——

function ManageModal(props: {
  holders: Holder[];
  categories: Category[];
  allTags: DocTag[];
  onClose: () => void;
}) {
  const { holders, categories, allTags, onClose } = props;
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [holderName, setHolderName] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const { overlayRef, requestClose, onBackdropMouseDown } = useOverlayDialog(onClose, busy);

  async function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setBusy(true);
    setError("");
    try {
      const res = await fn();
      if (!res.ok) throw new Error(res.error);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      className="docs-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="管理分类与持有人"
      tabIndex={-1}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="docs-modal docs-modal-manage">
        <header className="docs-modal-head">
          <h2>管理持有人 / 分类 / 标签</h2>
          <button type="button" className="docs-icon-btn" onClick={requestClose} aria-label="关闭" disabled={busy}>✕</button>
        </header>
        <div className="docs-modal-body docs-manage-grid">
          <section>
            <h3>持有人</h3>
            <div className="docs-manage-add">
              <input value={holderName} onChange={(e) => setHolderName(e.target.value)} maxLength={40} placeholder="新增持有人姓名" />
              <button
                type="button"
                className="docs-mini-btn"
                disabled={busy || !holderName.trim()}
                onClick={async () => { await run(() => createHolderAction(holderName)); setHolderName(""); }}
              >
                添加
              </button>
            </div>
            <ul className="docs-manage-list">
              {holders.map((h) => (
                <li key={h.id}>
                  <span>{h.name}</span>
                  <span className="docs-manage-actions">
                    <button
                      type="button"
                      className="docs-mini-btn"
                      disabled={busy}
                      onClick={() => {
                        const name = window.prompt("重命名持有人", h.name);
                        if (name && name.trim()) void run(() => renameHolderAction(h.id, name));
                      }}
                    >
                      重命名
                    </button>
                    <button type="button" className="docs-mini-btn docs-mini-danger" disabled={busy} onClick={() => { if (window.confirm(`删除持有人「${h.name}」？其证件会保留为未指定。`)) void run(() => deleteHolderAction(h.id)); }}>
                      删除
                    </button>
                  </span>
                </li>
              ))}
              {holders.length === 0 ? <li className="docs-hint">还没有持有人</li> : null}
            </ul>
          </section>
          <section>
            <h3>分类</h3>
            <div className="docs-manage-add">
              <input value={categoryName} onChange={(e) => setCategoryName(e.target.value)} maxLength={40} placeholder="新增分类名称" />
              <button
                type="button"
                className="docs-mini-btn"
                disabled={busy || !categoryName.trim()}
                onClick={async () => { await run(() => createCategoryAction(categoryName)); setCategoryName(""); }}
              >
                添加
              </button>
            </div>
            <ul className="docs-manage-list">
              {categories.map((c) => (
                <li key={c.id}>
                  <span>{c.name}</span>
                  <span className="docs-manage-actions">
                    <button
                      type="button"
                      className="docs-mini-btn"
                      disabled={busy}
                      onClick={() => {
                        const name = window.prompt("重命名分类", c.name);
                        if (name && name.trim()) void run(() => renameCategoryAction(c.id, name));
                      }}
                    >
                      重命名
                    </button>
                    <button type="button" className="docs-mini-btn docs-mini-danger" disabled={busy} onClick={() => { if (window.confirm(`删除分类「${c.name}」？其证件会保留为未分类。`)) void run(() => deleteCategoryAction(c.id)); }}>
                      删除
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>标签</h3>
            <ul className="docs-manage-list">
              {allTags.map((t) => (
                <li key={t.id}>
                  <span>{t.name}</span>
                  <span className="docs-manage-actions">
                    <button type="button" className="docs-mini-btn docs-mini-danger" disabled={busy} onClick={() => { if (window.confirm(`删除标签「${t.name}」？`)) void run(() => deleteTagAction(t.id)); }}>
                      删除
                    </button>
                  </span>
                </li>
              ))}
              {allTags.length === 0 ? <li className="docs-hint">还没有标签</li> : null}
            </ul>
          </section>
        </div>
        {error ? <p className="docs-error docs-error-pad" role="alert">{error}</p> : null}
      </div>
    </div>
  );
}

// —— 主组件 ——

export function DocumentsClient(props: {
  documents: DocumentRecord[];
  holders: Holder[];
  categories: Category[];
  tags: DocTag[];
  /** 首页入口链接可带 ?status= 过滤参数（由 page 层解析后传入）。 */
  initialStatus?: "all" | DocStatus;
}) {
  const { documents, holders, categories, tags, initialStatus = "all" } = props;
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [holderFilter, setHolderFilter] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState(0);
  const [tagFilter, setTagFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | DocStatus>(initialStatus);
  const [sort, setSort] = useState<SortMode>("custom");
  // 自定义排序：拖拽/箭头调整后的本地顺序覆盖；服务端确认后随 props 回来清空。
  const [orderOverride, setOrderOverride] = useState<number[] | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const reorderBusyRef = useRef(false);
  const [orderError, setOrderError] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  // 「续签」预填：基于现有证件复制一份，日期清空重新录入。
  const [renewFrom, setRenewFrom] = useState<FormState | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const selected = documents.find((d) => d.id === selectedId) ?? null;

  const summary = useMemo(() => {
    let upcoming = 0;
    let expiring = 0;
    let expired = 0;
    for (const d of documents) {
      if (d.status === "upcoming") upcoming += 1;
      if (d.status === "expiring") expiring += 1;
      if (d.status === "expired") expired += 1;
    }
    return { total: documents.length, upcoming, expiring, expired };
  }, [documents]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byId = new Map(documents.map((d) => [d.id, d]));
    const base = orderOverride
      ? orderOverride.map((id) => byId.get(id)).filter((d): d is DocumentRecord => Boolean(d))
      : documents;
    const arr = base.filter((d) => {
      if (statusFilter !== "all" && d.status !== statusFilter) return false;
      if (holderFilter !== 0 && d.holderId !== holderFilter) return false;
      if (categoryFilter !== 0 && d.categoryId !== categoryFilter) return false;
      if (tagFilter && !d.tags.some((t) => t.name === tagFilter)) return false;
      if (!q) return true;
      const hay = [d.title, d.number, d.issuer, d.note, d.holderName ?? "", d.categoryName ?? "", ...d.tags.map((t) => t.name)]
        .join("\n")
        .toLowerCase();
      return hay.includes(q);
    });
    if (sort === "created") {
      arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
    } else if (sort === "expiry") {
      arr.sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9) || a.title.localeCompare(b.title));
    }
    // custom：保持服务端/本地覆盖顺序。
    return arr;
  }, [documents, orderOverride, query, holderFilter, categoryFilter, tagFilter, statusFilter, sort]);

  // 服务端数据更新（含排序确认）后丢弃本地覆盖。
  useEffect(() => {
    setOrderOverride(null);
  }, [documents]);

  // 拖拽/箭头排序仅在「自定义」且无任何筛选时开放，避免保存部分顺序。
  const canReorder = sort === "custom" && !query.trim() && holderFilter === 0 && categoryFilter === 0 && !tagFilter && statusFilter === "all";

  function moveCard(id: number, targetId: number): void {
    if (reorderBusyRef.current) return;
    const current = orderOverride ?? documents.map((d) => d.id);
    const from = current.indexOf(id);
    const to = current.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = current.slice();
    next.splice(from, 1);
    const insertAt = next.indexOf(targetId) + (from < to ? 1 : 0);
    next.splice(insertAt, 0, id);
    void commitOrder(next);
  }

  function nudgeCard(id: number, delta: -1 | 1): void {
    if (reorderBusyRef.current) return;
    const current = orderOverride ?? documents.map((d) => d.id);
    const from = current.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= current.length) return;
    const next = current.slice();
    next.splice(to, 0, next.splice(from, 1)[0]);
    void commitOrder(next);
  }

  async function commitOrder(next: number[]): Promise<void> {
    if (reorderBusyRef.current) return;
    reorderBusyRef.current = true;
    setReorderBusy(true);
    setOrderError("");
    setOrderOverride(next);
    try {
      const res = await reorderDocumentsAction(next);
      if (!res.ok) throw new Error(res.error);
    } catch (error) {
      setOrderOverride(null);
      setOrderError(`排序未保存：${error instanceof Error ? error.message : "网络错误，请重试"}`);
      router.refresh();
    } finally {
      reorderBusyRef.current = false;
      setReorderBusy(false);
    }
  }

  const drawerImages = selected?.files.filter((f) => f.isImage) ?? [];

  function openNew() {
    setRenewFrom(null);
    setSelectedId(null);
    setLightboxIndex(null);
    setFormOpen(true);
  }

  return (
    <div className="docs-root">
      <header className="docs-hero">
        <p className="docs-kicker">Document Vault</p>
        <h1 className="docs-title">证件夹</h1>
        <p className="docs-sub">集中管理证件与签证的有效期、扫描件和标签，到期前站内提醒。</p>
        <div className="docs-actions">
          <button type="button" className="docs-btn docs-btn-primary" onClick={openNew}>＋ 新增证件</button>
          <button type="button" className="docs-btn" onClick={() => setManageOpen(true)}>管理分类 / 持有人</button>
        </div>
        <div className="docs-stats" role="group" aria-label="证件状态统计">
          <button
            type="button"
            className={`docs-stat${statusFilter === "all" ? " is-active" : ""}`}
            onClick={() => setStatusFilter("all")}
          >
            全部 <strong>{summary.total}</strong>
          </button>
          <button
            type="button"
            className={`docs-stat docs-stat-upcoming${statusFilter === "upcoming" ? " is-active" : ""}`}
            onClick={() => setStatusFilter(statusFilter === "upcoming" ? "all" : "upcoming")}
          >
            尚未生效 <strong>{summary.upcoming}</strong>
          </button>
          <button
            type="button"
            className={`docs-stat docs-stat-warn${statusFilter === "expiring" ? " is-active" : ""}`}
            onClick={() => setStatusFilter(statusFilter === "expiring" ? "all" : "expiring")}
          >
            即将到期 <strong>{summary.expiring}</strong>
          </button>
          <button
            type="button"
            className={`docs-stat docs-stat-danger${statusFilter === "expired" ? " is-active" : ""}`}
            onClick={() => setStatusFilter(statusFilter === "expired" ? "all" : "expired")}
          >
            已过期 <strong>{summary.expired}</strong>
          </button>
        </div>
      </header>

      <div className="docs-filters">
        <input
          className="docs-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称、号码、标签、备注…"
          aria-label="搜索证件"
        />
        <select value={holderFilter} onChange={(e) => setHolderFilter(Number(e.target.value))} aria-label="按持有人筛选">
          <option value={0}>全部持有人</option>
          {holders.map((h) => (
            <option key={h.id} value={h.id}>{h.name}</option>
          ))}
        </select>
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(Number(e.target.value))} aria-label="按分类筛选">
          <option value={0}>全部分类</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="按标签筛选">
          <option value="">全部标签</option>
          {tags.map((t) => (
            <option key={t.id} value={t.name}>{t.name}</option>
          ))}
        </select>
        <select value={sort} onChange={(e) => { setOrderOverride(null); setSort(e.target.value as SortMode); }} aria-label="排序">
          <option value="custom">自定义排序</option>
          <option value="expiry">按到期时间</option>
          <option value="created">按添加时间</option>
        </select>
        {sort === "custom" ? <span className="docs-hint docs-sort-hint">{canReorder ? "拖动卡片，或用箭头调整顺序；修改会自动保存。" : "筛选中无法调整顺序，清除筛选后即可排序。"}</span> : null}
      </div>
      {orderError ? <p className="docs-error" role="alert">{orderError}</p> : null}
      {reorderBusy ? <p className="docs-hint" role="status">正在保存顺序…</p> : null}

      {visible.length === 0 ? (
        <p className="docs-empty">
          {documents.length === 0
            ? "还没有证件。点击「新增证件」录入第一份吧。"
            : "没有符合条件的证件，试试调整筛选条件。"}
        </p>
      ) : (
        <div className="docs-grid">
          {visible.map((d, index) => {
            const cover = d.files.find((f) => f.isImage);
            return (
              <div key={d.id} className="docs-card-wrap">
                {canReorder ? (
                  <span className="docs-card-arrows">
                    <button
                      type="button"
                      className="docs-mini-btn"
                      aria-label={`将「${d.title}」前移`}
                      disabled={reorderBusy || index === 0}
                      onClick={(e) => { e.stopPropagation(); nudgeCard(d.id, -1); }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="docs-mini-btn"
                      aria-label={`将「${d.title}」后移`}
                      disabled={reorderBusy || index === visible.length - 1}
                      onClick={(e) => { e.stopPropagation(); nudgeCard(d.id, 1); }}
                    >
                      ↓
                    </button>
                  </span>
                ) : null}
                <button
                  type="button"
                  className={`docs-card docs-card-${d.status}${dragId === d.id ? " is-dragging" : ""}`}
                  draggable={canReorder && !reorderBusy}
                  onDragStart={(e) => { setDragId(d.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(d.id)); }}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => { if (dragId !== null && dragId !== d.id) e.preventDefault(); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId !== null && dragId !== d.id) moveCard(dragId, d.id);
                    setDragId(null);
                  }}
                  onClick={() => { setSelectedId(d.id); setLightboxIndex(null); }}
                >
                  <span className="docs-card-strip" aria-hidden />
                  <div className="docs-card-cover">
                    {cover ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={fileUrl(cover.file)} alt="" loading="lazy" />
                    ) : (
                      <span className="docs-card-emoji" aria-hidden>{categoryEmoji(d.categoryName)}</span>
                    )}
                  </div>
                  <div className="docs-card-body">
                    <div className="docs-card-top">
                      <div className="docs-card-heading">
                        <h2 className="docs-card-title">{d.title}</h2>
                        <span className={`docs-status docs-status-${d.status}`}>{STATUS_LABELS[d.status]}</span>
                      </div>
                      <DaysRing doc={d} />
                    </div>
                    <p className="docs-card-meta">
                      {[d.holderName, d.categoryName].filter(Boolean).join(" · ") || "未分类"}
                    </p>
                    <p className={`docs-card-expiry docs-card-expiry-${d.status}`}>
                      {d.expiryDate ? `${d.expiryDate} · ${daysText(d)}` : "长期有效"}
                    </p>
                    {d.tags.length > 0 ? (
                      <div className="docs-tags">
                        {d.tags.slice(0, 4).map((t) => (
                          <span key={t.id} className="docs-tag">{t.name}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* 主 overlay 互斥渲染：表单弹窗打开时不渲染抽屉，避免抽屉盖住弹窗。 */}
      {formOpen ? (
        <FormModal
          doc={renewFrom ? null : selected}
          initial={renewFrom}
          heading={renewFrom ? "续签证件" : undefined}
          holders={holders}
          categories={categories}
          allTags={tags}
          onClose={() => { setFormOpen(false); setRenewFrom(null); }}
          onSaved={(id) => {
            setFormOpen(false);
            setRenewFrom(null);
            setLightboxIndex(null);
            setSelectedId(id);
            router.refresh();
          }}
        />
      ) : selected ? (
        <DetailDrawer
          doc={selected}
          onClose={() => { setSelectedId(null); setLightboxIndex(null); router.refresh(); }}
          onEdit={() => { setLightboxIndex(null); setRenewFrom(null); setFormOpen(true); }}
          onRenew={() => {
            setLightboxIndex(null);
            setRenewFrom({ ...formFromDoc(selected), number: "", startDate: "", expiryDate: "", durationValue: "" });
            setFormOpen(true);
          }}
          onLightbox={(i) => setLightboxIndex(i)}
        />
      ) : null}

      {selected && lightboxIndex !== null && drawerImages.length > 0 ? (
        <Lightbox
          images={drawerImages}
          index={Math.min(lightboxIndex, drawerImages.length - 1)}
          onClose={() => setLightboxIndex(null)}
          onIndex={setLightboxIndex}
        />
      ) : null}

      {manageOpen ? <ManageModal holders={holders} categories={categories} allTags={tags} onClose={() => setManageOpen(false)} /> : null}
    </div>
  );
}
