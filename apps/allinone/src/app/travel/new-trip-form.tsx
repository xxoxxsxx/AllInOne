"use client";

// 新建行程表单：提交给 createTripAction（服务端组件表单动作）。

import { useRef } from "react";

import { createTripAction } from "./actions";

export function NewTripForm() {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form ref={ref} action={createTripAction} className="new-trip-form">
      <input
        name="title"
        required
        maxLength={80}
        placeholder="行程名称，如：大理 5 日"
        aria-label="行程名称"
        className="new-trip-input new-trip-title"
      />
      <input
        name="startDate"
        type="date"
        aria-label="出发日期（可选）"
        className="new-trip-input"
      />
      <input
        name="description"
        maxLength={200}
        placeholder="一句话简介（可选）"
        aria-label="行程简介（可选）"
        className="new-trip-input new-trip-desc"
      />
      <button type="submit" className="btn btn-primary">＋ 新建行程</button>
    </form>
  );
}
