"use client";

// 行程卡片上的删除按钮：确认后提交 deleteTripAction（服务端 redirect 回列表页）。

import { deleteTripAction } from "./actions";

export function DeleteTripButton({ tripId, title }: { tripId: number; title: string }) {
  return (
    <form
      className="trip-card-delete"
      action={deleteTripAction}
      onClick={(e) => {
        // 拦截卡片链接的冒泡与默认跳转由外层结构保证；这里只负责确认。
        e.stopPropagation();
      }}
      onSubmit={(e) => {
        if (!window.confirm(`删除行程「${title}」？地点、链接与照片都会一并删除。`)) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="id" value={tripId} />
      <button type="submit" className="trip-card-delete-btn" title={`删除行程「${title}」`} aria-label={`删除行程「${title}」`}>
        🗑
      </button>
    </form>
  );
}
