"use client";

import { useEffect, useRef, useState } from "react";
import type { Trip } from "@/lib/travel/db";
import { ExportAbortedError, type ExportedImage } from "@/lib/travel/export-image";
import "./export-trip.css";

type PreviewImage = ExportedImage & { url: string };

export function TravelExportButton({ trip }: { trip: Trip }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [images, setImages] = useState<PreviewImage[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [canShare, setCanShare] = useState(false);
  const [sharing, setSharing] = useState(false);
  const urls = useRef<string[]>([]);
  const alive = useRef(true);
  const lock = useRef(false);
  const sharingLock = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const clearUrls = () => { urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current = []; };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // 卸载即取消在途生成，避免无主循环继续 fetch/decode/toBlob 占资源。
      abortRef.current?.abort();
      clearUrls();
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; trigger.current?.focus(); };
  }, [open]);

  // busy 时关闭 = 取消在途生成：立即关面板并 abort，错误按取消静默。
  const close = () => {
    if (lock.current) abortRef.current?.abort();
    setOpen(false); setImages([]); clearUrls();
  };
  const generate = async () => {
    if (lock.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    lock.current = true; setBusy(true); setError(""); setWarnings([]); setImages([]); clearUrls(); setOpen(true); setProgress("准备生成长图…");
    try {
      const { renderTripImages } = await import("@/lib/travel/export-image");
      const result = await renderTripImages(trip, (done, total) => {
        if (alive.current) setProgress(`已生成 ${done} / ${total} 张`);
      }, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      const previews = result.images.map(image => ({ ...image, url: URL.createObjectURL(image.blob) }));
      urls.current = previews.map(image => image.url);
      setImages(previews); setWarnings(result.warnings);
      const files = previews.map(image => new File([image.blob], image.name, { type: "image/png" }));
      try { setCanShare(!!navigator.canShare?.({ files })); } catch { setCanShare(false); }
    } catch (e) {
      if (!alive.current || controller.signal.aborted || e instanceof ExportAbortedError) return;
      setError(e instanceof Error ? e.message : "长图生成失败，请重试");
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const share = async () => {
    if (sharingLock.current || !images.length) return;
    sharingLock.current = true; setSharing(true);
    const files = images.map(image => new File([image.blob], image.name, { type: "image/png" }));
    try {
      await navigator.share({ files, title: trip.title });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError("系统分享失败，请下载 PNG 后手动发送。");
    } finally {
      sharingLock.current = false;
      if (alive.current) setSharing(false);
    }
  };
  return <>
    <button ref={trigger} type="button" className="btn btn-ghost btn-sm" onClick={generate}>导出长图</button>
    {open && <div className="travel-export-overlay" onClick={close}>
      <div ref={panel} className="travel-export-panel" role="dialog" aria-modal="true" aria-label="导出旅行攻略长图" tabIndex={-1} onClick={e => e.stopPropagation()} onKeyDown={e => {
        if (e.key === "Escape") close();
        if (e.key === "Tab") {
          const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
          if (!controls?.length) { e.preventDefault(); return; }
          const first = controls[0], last = controls[controls.length - 1];
          if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }}>
        <header className="travel-export-head"><h2>旅行攻略长图</h2><button type="button" onClick={close}>{busy ? "取消" : "关闭"}</button></header>
        <p>生成 PNG，适合微信发送与离线保存；不会创建公开链接。每张最多 12000px，过长自动分图。</p>
        {busy && <p role="status">{progress}，可随时取消。</p>}
        {error && <p className="travel-export-error" role="alert">{error}</p>}
        {!busy && error && images.length === 0 && <button type="button" onClick={generate}>重新生成</button>}
        {warnings.length > 0 && <p className="travel-export-error" role="status">有 {warnings.length} 张照片加载失败，长图对应位置已注明。可关闭后重新导出。</p>}
        {canShare && images.length > 0 && <button type="button" disabled={sharing} onClick={share}>{sharing ? "分享中…" : "系统分享图片"}</button>}
        {images.map((image, i) => <section className="travel-export-page" key={image.url}>
          <div className="travel-export-page-head"><span>第 {i + 1} / {images.length} 张 · {image.width} × {image.height}</span><a href={image.url} download={image.name}>下载 PNG</a></div>
          {/* 浏览器预览使用 Blob URL，原图不经过远端转换。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.url} alt={`旅行攻略第 ${i + 1} 张预览`} loading="lazy" />
        </section>)}
      </div>
    </div>}
  </>;
}
