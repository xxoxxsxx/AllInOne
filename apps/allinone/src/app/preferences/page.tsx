"use client";

import { useState } from "react";
import { clearAllPreferences, readFavorites, readRecent, writeTheme } from "@/lib/storage";

type Theme = "light" | "dark" | "system";

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

function currentTheme(): Theme {
  if (typeof document === "undefined") return "system";
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}

export default function PreferencesPage() {
  const [theme, setTheme] = useState<Theme | null>(null);
  const [cleared, setCleared] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const effectiveTheme = theme ?? currentTheme();

  const applyTheme = (next: Theme) => {
    setTheme(next);
    writeTheme(next);
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = next;
    }
  };

  const handleClear = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    clearAllPreferences();
    setCleared(true);
    setConfirming(false);
  };

  return (
    <div>
      <h1 className="page-title">偏好</h1>
      <p className="page-sub">偏好仅保存在当前设备浏览器中，不影响工具业务数据。</p>

      <div className="pref-card">
        <h2>主题</h2>
        <div className="theme-options" role="group" aria-label="主题选择">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="category-chip"
              aria-pressed={effectiveTheme === option.value}
              onClick={() => applyTheme(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="pref-hint">主题仅约束门户本身；各工具内部界面沿用其自有样式。</p>
      </div>

      <div className="pref-card">
        <h2>本机数据</h2>
        <p className="pref-hint">
          当前收藏 {readFavorites().length} 项，最近打开 {readRecent().length} 项。清除后不可恢复；CDK、股票、照片等业务数据不受影响。
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" className="danger-button" onClick={handleClear}>
            {confirming ? "再点一次确认清除" : "清除收藏与最近记录"}
          </button>
          {cleared ? <span className="status-item-detail">已清除。</span> : null}
        </div>
      </div>
    </div>
  );
}
