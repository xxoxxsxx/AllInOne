"use client";

import { useEffect, useRef, useState } from "react";

import { acquireBodyScrollLock, releaseBodyScrollLock } from "./scroll-lock";

export type LightboxPhoto = { id: number; url: string; caption: string };

export function PhotoLightbox({ photos, photoId, onClose, onNavigate }: {
  photos: LightboxPhoto[];
  photoId: number;
  onClose: () => void;
  onNavigate: (photoId: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const index = photos.findIndex(p => p.id === photoId);
  const photo = photos[index];
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  // Native modal isolates background controls, including the still-mounted editor.
  // Keep this effect independent of navigation so focus/scroll restoration happens
  // only on open/close (also balanced under StrictMode's setup-cleanup-setup).
  useEffect(() => {
    const target = document.activeElement as HTMLElement | null;
    const el = dialog.current;
    el?.showModal();
    closeButton.current?.focus();
    acquireBodyScrollLock();
    return () => {
      el?.close();
      releaseBodyScrollLock();
      if (target?.isConnected) target.focus();
    };
  }, []);

  useEffect(() => {
    if (!photo) onClose();
  }, [photo, onClose]);

  useEffect(() => {
    if (index < 0 || photos.length < 2) return;
    for (const i of [index - 1, index + 1]) {
      const img = new Image();
      img.src = photos[(i + photos.length) % photos.length].url;
    }
  }, [index, photos]);

  const navigate = (delta: number) => {
    if (index >= 0 && photos.length > 1) onNavigate(photos[(index + delta + photos.length) % photos.length].id);
  };

  return <dialog ref={dialog} className="t-lightbox" aria-label={`照片 ${index + 1} / ${photos.length}`}
    onCancel={e => { e.preventDefault(); onClose(); }}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    onKeyDown={e => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); e.stopPropagation(); navigate(e.key === "ArrowLeft" ? -1 : 1);
      }
      if (e.key === "Tab") {
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) return;
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }}>
    <header className="t-lightbox-head">
      <span className="t-lightbox-caption" aria-live="polite">{photo?.caption} · {index + 1} / {photos.length}</span>
      <button ref={closeButton} type="button" className="t-lightbox-close" onClick={onClose} aria-label="关闭灯箱">✕</button>
    </header>
    <div className="t-lightbox-stage" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      {photos.length > 1 && <button type="button" className="t-lightbox-nav" aria-label="上一张" onClick={() => navigate(-1)}>‹</button>}
      <div className="t-lightbox-frame" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        {photo && (failedUrl === photo.url ? <p role="alert" className="t-lightbox-error">照片加载失败，请关闭后重试；仍可继续浏览其他照片。</p> :
          // eslint-disable-next-line @next/next/no-img-element
          <img key={photo.url} className="t-lightbox-img" src={photo.url} alt={photo.caption} onError={() => setFailedUrl(photo.url)} />)}
      </div>
      {photos.length > 1 && <button type="button" className="t-lightbox-nav" aria-label="下一张" onClick={() => navigate(1)}>›</button>}
    </div>
  </dialog>;
}
