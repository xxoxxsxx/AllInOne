"use server";

// 高德搜索设置：Key 只写服务端数据库，页面仅拿到 hasKey 布尔值。

import { revalidatePath } from "next/cache";

import { getTravelDB, saveAmapKey } from "@/lib/travel/db";

export async function saveAmapSettingsAction(key: string, clear: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = getTravelDB();
    if (clear) {
      saveAmapKey(db, "");
    } else {
      const trimmed = (key ?? "").trim();
      if (!trimmed) return { ok: true }; // 空表单 = 不修改
      saveAmapKey(db, trimmed);
    }
    revalidatePath("/travel");
    revalidatePath("/preferences");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "保存失败" };
  }
}
