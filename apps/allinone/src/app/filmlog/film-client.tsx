"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FilmInput, FilmRoll } from "@/lib/filmlog/store";
import { advanceRollAction, deleteImageAction, deleteRollAction, saveRollAction, uploadImageAction, type Result } from "./actions";

const stages = [
  { id: "stock", name: "在库", next: "装入相机" },
  { id: "shooting", name: "拍摄中", next: "拍摄完成" },
  { id: "shot", name: "已拍完", next: "送去冲洗" },
  { id: "developing", name: "冲洗中", next: "冲洗完成" },
  { id: "developed", name: "已冲洗", next: "" },
] as const;
const label = (status: string) => stages.find(s => s.id === status)?.name ?? status;
const photoUrl = (id: number, name: string) => `/filmlog/attachments/${id}/${encodeURIComponent(name)}`;
function expiry(date: string, today: string) {
  if (!date) return null;
  const days = Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
  if (!Number.isFinite(days)) return null;
  return days < 0 ? { text: `已过期 ${-days} 天`, cls: "expired" } : days <= 183 ? { text: days === 0 ? "今天过期" : `${days} 天后过期`, cls: "soon" } : null;
}
const fields: Array<{key: keyof FilmInput; label: string; type?: string; placeholder?: string; combo?: boolean}> = [
  { key:"brand", label:"品牌", placeholder:"例如 Kodak", combo:true }, { key:"film", label:"胶卷型号", placeholder:"例如 Portra 400", combo:true },
  { key:"iso", label:"感光度 ISO", placeholder:"例如 400", combo:true }, { key:"format", label:"规格", placeholder:"例如 135、120", combo:true },
  { key:"frames", label:"张数", placeholder:"例如 36" }, { key:"batch", label:"批次号", placeholder:"可选" },
  { key:"purchasedAt", label:"购买日期", type:"date" }, { key:"expiresAt", label:"过期日期", type:"date" },
  { key:"openedAt", label:"开始拍摄", type:"date" }, { key:"finishedAt", label:"拍摄完成", type:"date" },
  { key:"sentAt", label:"送洗日期", type:"date" }, { key:"developedAt", label:"冲洗完成", type:"date" },
  { key:"camera", label:"相机", placeholder:"例如 Nikon FM2", combo:true }, { key:"process", label:"冲洗工艺", placeholder:"例如 C-41、E-6、黑白", combo:true },
  { key:"lab", label:"冲洗店铺", placeholder:"店铺名称", combo:true }, { key:"purchasePrice", label:"购入价格", type:"number" },
  { key:"developPrice", label:"冲扫费用", type:"number" },
];

export function FilmClient({ rolls, today, options }: { rolls: FilmRoll[]; today: string; options: Record<string, string[]> }) {
  const router = useRouter();
  const [editing, setEditing] = useState<FilmRoll | "new" | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const execute = (operation: () => Promise<Result>, after?: () => void) => {
    setError(""); start(async () => { try { const result = await operation(); if (!result.ok) { setError(result.error); return; } after?.(); router.refresh(); } catch { setError("操作失败，请重试"); } });
  };
  const query = filter.trim().toLowerCase();
  const visible = rolls.filter(r => [r.brand,r.film,r.camera,r.lab,r.note,r.batch].some(v => v.toLowerCase().includes(query)));
  const expired = rolls.filter(r => r.expiresAt && expiry(r.expiresAt,today)?.cls === "expired" && r.status === "stock").length;
  const soon = rolls.filter(r => r.expiresAt && expiry(r.expiresAt,today)?.cls === "soon" && r.status === "stock").length;
  const spent = rolls.reduce((sum,r) => sum + (Number(r.purchasePrice) || 0) + (Number(r.developPrice) || 0),0);
  const ranking = (values: string[]) => {
    const counts = new Map<string,number>();
    for (const value of values) if (value.trim()) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts].sort((a,b) => b[1] - a[1]).slice(0,5).map(([name,count]) => `${name} ${count} 卷`).join(" · ") || "暂无记录";
  };
  return <>
    <header className="film-hero"><div><p className="film-eyebrow">YOUR FILM, YOUR STORY</p><h1>胶卷日志</h1><p>从买下第一卷，到冲洗出最后一张，给每卷胶卷留一本小小的档案。</p></div><button className="film-primary" onClick={() => { setError(""); setEditing("new"); }}>＋ 记录一卷</button></header>
    <section className="film-stats" aria-label="胶卷统计"><div><strong>{rolls.length}</strong><span>胶卷总数</span></div><div><strong>{rolls.filter(r => r.status === "stock").length}</strong><span>库存胶卷</span></div><div><strong>{rolls.filter(r => r.status === "shooting").length}</strong><span>拍摄中</span></div><div><strong>{rolls.filter(r => r.status === "developed").length}</strong><span>已冲洗</span></div><div><strong>{spent.toFixed(2)}</strong><span>已记录费用合计</span></div></section>
    {rolls.length > 0 && <details className="film-editor"><summary>查看型号、相机与店铺统计</summary><p>{today.slice(0,4)} 年拍完：{rolls.filter(r => r.finishedAt.startsWith(today.slice(0,4) + "-")).length} 卷</p><p>胶卷型号：{ranking(rolls.map(r => [r.brand,r.film].filter(Boolean).join(" ")))}</p><p>相机：{ranking(rolls.map(r => r.camera))}</p><p>冲洗店铺：{ranking(rolls.map(r => r.lab))}</p></details>}
    {(expired > 0 || soon > 0) && <p className="film-alert">库存中 {expired > 0 && `${expired} 卷已过期`}{expired > 0 && soon > 0 && "，"}{soon > 0 && `${soon} 卷将在半年内过期`}。过期胶卷仍可继续记录和拍摄。</p>}
    {error && <p className="film-error" role="alert">{error}</p>}
    {editing && <section className="film-editor" aria-label={editing === "new" ? "新增胶卷" : "编辑胶卷"}>
      <div className="film-section-heading"><h2>{editing === "new" ? "记录一卷胶卷" : "编辑胶卷"}</h2><button onClick={() => {setEditing(null);setError("");}} className="film-text">关闭 ✕</button></div>
      <p className="film-hint">只需填写型号；日期和其他信息可随时补充。价格统一按你的记账币种填写。</p>
      <form key={editing === "new" ? "new" : editing.id} onSubmit={e => { e.preventDefault(); const el = e.currentTarget; const fd = new FormData(el);
        // 新选项确认：填写值不在下拉选项中时，询问是否保存供日后选择（取消则仅本次使用）。
        const novel: Record<string, string[]> = {};
        for (const f of fields.filter(x => x.combo)) {
          const value = String(fd.get(f.key) ?? "").trim();
          if (!value || (options[f.key] ?? []).includes(value)) continue;
          (novel[f.key] ??= []).push(value);
        }
        const names = Object.entries(novel).map(([field, values]) => `${fields.find(x => x.key === field)?.label ?? field}：${values.join("、")}`);
        if (names.length) {
          if (window.confirm(`是否保存这些新选项，方便日后下拉选择？\n${names.join("\n")}\n（选「取消」仅本次使用，不保存选项）`)) {
            fd.set("new_options", JSON.stringify(novel));
          } else {
            fd.delete("new_options");
          }
        }
        execute(() => saveRollAction(fd), () => setEditing(null)); }}>
        {editing !== "new" && <input type="hidden" name="id" value={editing.id} />}
        <div className="film-fields">{fields.map(f => { const list = options[f.key] ?? []; return <label key={f.key}>{f.label}
          {f.combo ? <><input name={f.key} type="text" list={`film-opt-${f.key}`} placeholder={f.placeholder} defaultValue={editing === "new" ? "" : editing[f.key]} required={f.key === "film"} /><datalist id={`film-opt-${f.key}`}>{list.map(o => <option key={o} value={o} />)}</datalist></>
            : <input name={f.key} type={f.type ?? "text"} placeholder={f.placeholder} defaultValue={editing === "new" ? "" : editing[f.key]} required={f.key === "film"} {...(f.type === "number" ? { min:0, step:"0.01" } : {})}/>}
        </label>; })}
          <label>当前状态<select name="status" defaultValue={editing === "new" ? "stock" : editing.status}>{stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="film-wide">拍摄内容与备注<textarea name="note" rows={3} placeholder="这卷拍了什么？记录地点、故事或冲洗细节。" defaultValue={editing === "new" ? "" : editing.note} /></label>
        </div><div className="film-actions"><button type="submit" className="film-primary" disabled={pending}>{pending ? "保存中…" : "保存胶卷"}</button><button type="button" className="film-secondary" onClick={() => setEditing(null)}>取消</button></div>
      </form>
    </section>}
    <section className="film-list"><div className="film-section-heading"><div><p className="film-eyebrow">THE ROLL COLLECTION</p><h2>我的胶卷</h2></div><input className="film-search" type="search" placeholder="搜索型号、相机、店铺或备注" value={filter} onChange={e => setFilter(e.target.value)} aria-label="搜索胶卷" /></div>
    {visible.length === 0 ? <p className="film-empty">{rolls.length ? "没有找到匹配的胶卷。" : "还没有记录。点击「记录一卷」，从你的第一卷开始。"}</p> : stages.map(stage => { const group = visible.filter(r => r.status === stage.id); if (!group.length) return null; return <div className="film-stage" key={stage.id}><h3>{stage.name} <span>{group.length}</span></h3><div className="film-grid">{group.map(r => {const exp=expiry(r.expiresAt,today); return <article className="film-card" key={r.id}>
      <div className="film-card-head"><div><p className="film-brand">{r.brand || "FILM ROLL"}</p><h4>{r.film}</h4></div><span className="film-badge">{label(r.status)}</span></div>
      <p className="film-meta">{[r.iso && `ISO ${r.iso}`,r.format,r.frames && `${r.frames} 张`,r.batch && `批次 ${r.batch}`].filter(Boolean).join(" · ") || "规格待补充"}</p>
      {exp && <span className={`film-expiry ${exp.cls}`}>{exp.text}</span>}
      <dl className="film-dates">{([["购买",r.purchasedAt],["过期",r.expiresAt],["开始拍摄",r.openedAt],["拍摄完成",r.finishedAt],["送洗",r.sentAt],["冲洗完成",r.developedAt],["相机",r.camera],["工艺",r.process],["店铺",r.lab],["购入价格",r.purchasePrice],["冲扫费用",r.developPrice]] as string[][]).filter(([,v]) => !!v).map(([k,v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {r.note && <p className="film-note">{r.note}</p>}
      {r.images.length > 0 && <div className="film-images">{r.images.map(img => <div key={img.id}><a href={photoUrl(r.id,img.filename)} target="_blank" rel="noreferrer"><img src={photoUrl(r.id,img.filename)} alt={img.name} loading="lazy" /></a><button type="button" aria-label={`删除图片 ${img.name}`} onClick={() => {if (window.confirm("删除这张图片？")) execute(() => deleteImageAction(r.id,img.id));}}>×</button></div>)}</div>}
      <div className="film-actions">{stage.next && <button className="film-primary" disabled={pending} onClick={() => execute(() => advanceRollAction(r.id))}>{stage.next} →</button>}<button className="film-secondary" onClick={() => {setError("");setEditing(r);window.scrollTo({top:0,behavior:"smooth"});}}>编辑</button><button className="film-text film-danger" disabled={pending} onClick={() => { if (window.confirm("确定删除这卷胶卷及其图片？")) execute(() => deleteRollAction(r.id)); }}>删除</button></div>
      <form className="film-upload" onSubmit={e => {e.preventDefault(); const el=e.currentTarget; const fd=new FormData(el); execute(() => uploadImageAction(r.id,fd), () => el.reset());}}><label>扫描图或小票 <input type="file" name="image" accept="image/jpeg,image/png,image/webp" required /></label><button className="film-secondary" disabled={pending}>上传图片</button></form>
    </article>; })}</div></div>; })}</section>
  </>;
}
