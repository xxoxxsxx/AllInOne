"use client";

// 统一的背景滚动锁：引用计数，多个弹层（灯箱/导出面板）叠加时，
// 先关闭的不再把 body.overflow 恢复成另一个弹层设置的 "hidden"。
let count = 0;
let previous: string | null = null;

export function acquireBodyScrollLock(): void {
  if (count === 0) {
    previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  count += 1;
}

export function releaseBodyScrollLock(): void {
  if (count === 0) return;
  count -= 1;
  if (count === 0) {
    document.body.style.overflow = previous ?? "";
    previous = null;
  }
}
