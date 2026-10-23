"use client";

import { useState } from "react";
import type { ToolConfig } from "@/lib/types";
import { isFavorite, pushRecent, toggleFavorite } from "@/lib/storage";

export const STATUS_LABEL: Record<string, string> = {
  ok: "可访问",
  unreachable: "暂不可用",
  unknown: "未知",
  unmonitored: "未监测",
};

// 详情页操作区：打开（按 openMode）+ 收藏切换。
export function OpenButton({ tool }: { tool: ToolConfig }) {
  const external = tool.openMode === "new-tab";
  return (
    <a
      className="open-button"
      href={tool.entry}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      style={{ alignSelf: "flex-start" }}
      onClick={() => pushRecent(tool.id)}
    >
      打开工具{external ? " ↗" : ""}
    </a>
  );
}

export function FavoriteToggle({ tool }: { tool: ToolConfig }) {
  const [favorite, setFavorite] = useState<boolean | null>(null);
  const effective = favorite ?? (typeof window !== "undefined" ? isFavorite(tool.id) : false);
  return (
    <button
      type="button"
      className="fav-button"
      aria-pressed={effective}
      aria-label={effective ? `取消收藏 ${tool.name}` : `收藏 ${tool.name}`}
      onClick={() => setFavorite(toggleFavorite(tool.id))}
    >
      {effective ? "★" : "☆"}
    </button>
  );
}
