"use client";

// 照片灯箱：全屏查看大图，←/→ 或箭头按钮翻页，Esc 关闭；预加载相邻两张。
// photos 为行程内全局有序列表，从任意缩略图进入都能连续翻完整趟行程。

import { useEffect } from "react";

export type LightboxPhoto = {
  url: string;
  caption: string;
};

export function PhotoLightbox({
  photos,
  index,
  onClose,
  onNavigate,
}: {
  photos: LightboxPhoto[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const count = photos.length;
  const photo = photos[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onNavigate((index - 1 + count) % count);
      else if (e.key === "ArrowRight") onNavigate((index + 1) % count);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [index, count, onClose, onNavigate]);

  // 预加载相邻照片，翻页不闪白。
  useEffect(() => {
    for (const i of [index - 1, index + 1]) {
      const neighbor = photos[(i + count) % count];
      if (neighbor) {
        const img = new Image();
        img.src = neighbor.url;
      }
    }
  }, [index, count, photos]);

  if (!photo) return null;

  return (
    <div
      className="t-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`照片 ${index + 1} / ${count}`}
      onClick={onClose}
    >
      <header className="t-lightbox-head">
        <span className="t-lightbox-caption">
          {photo.caption} · {index + 1} / {count}
        </span>
        <button type="button" className="t-lightbox-close" onClick={onClose} aria-label="关闭灯箱">✕</button>
      </header>
      <div className="t-lightbox-stage">
        {count > 1 ? (
          <button
            type="button"
            className="t-lightbox-nav"
            aria-label="上一张"
            onClick={(e) => { e.stopPropagation(); onNavigate((index - 1 + count) % count); }}
          >
            ‹
          </button>
        ) : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="t-lightbox-img" src={photo.url} alt={photo.caption} onClick={(e) => e.stopPropagation()} />
        {count > 1 ? (
          <button
            type="button"
            className="t-lightbox-nav"
            aria-label="下一张"
            onClick={(e) => { e.stopPropagation(); onNavigate((index + 1) % count); }}
          >
            ›
          </button>
        ) : null}
      </div>
    </div>
  );
}
