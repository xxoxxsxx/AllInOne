"use client";

// 弹窗/抽屉共享 overlay hook：
// - Escape 只响应最上层 overlay（模块级栈），busy 时拒绝关闭（防误触）；
// - Tab 焦点圈定在 overlay 内，关闭后焦点还原到打开前的元素；
// - body 滚动锁按计数管理（灯箱叠在抽屉上时不会提前解锁）。

import { useEffect, useRef, type SyntheticEvent } from "react";

type OverlayEntry = {
  locked: () => boolean;
  close: () => void;
};

const overlayStack: OverlayEntry[] = [];
let scrollLocks = 0;
let prevOverflow = "";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
  );
}

/**
 * @param close 关闭回调
 * @param locked 为 true 时（保存/上传中）Escape、遮罩点击都无法关闭
 */
export function useOverlayDialog(close: () => void, locked = false) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ close, locked });
  stateRef.current = { close, locked };

  useEffect(() => {
    const entry: OverlayEntry = {
      locked: () => stateRef.current.locked,
      close: () => stateRef.current.close(),
    };
    overlayStack.push(entry);

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = overlayRef.current;
    if (container && !(document.activeElement instanceof HTMLElement && container.contains(document.activeElement))) {
      container.focus();
    }

    if (scrollLocks === 0) {
      prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    scrollLocks += 1;

    function onKeyDown(e: KeyboardEvent) {
      // 栈顶才响应，避免抽屉 + 灯箱（或弹窗）各自监听时一次 Escape 全关。
      if (overlayStack[overlayStack.length - 1] !== entry) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (!entry.locked()) entry.close();
        return;
      }
      const containerNow = overlayRef.current;
      if (e.key === "Tab" && containerNow) {
        const items = focusableIn(containerNow);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        const inside = active instanceof HTMLElement && containerNow.contains(active);
        if (e.shiftKey && (active === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const idx = overlayStack.indexOf(entry);
      if (idx >= 0) overlayStack.splice(idx, 1);
      scrollLocks -= 1;
      if (scrollLocks === 0) {
        document.body.style.overflow = prevOverflow;
      }
      previousFocus?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** busy 安全的关闭入口：供遮罩点击和 ✕ 按钮使用。 */
  function requestClose() {
    if (!stateRef.current.locked) stateRef.current.close();
  }

  function onBackdropMouseDown(e: SyntheticEvent) {
    if (e.target === e.currentTarget) requestClose();
  }

  return { overlayRef, requestClose, onBackdropMouseDown };
}
