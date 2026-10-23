"use client";

import { ICONS, DEFAULT_ICON } from "@/lib/icons";

export function ToolIcon({ icon }: { icon: string }) {
  const path = ICONS[icon] ?? ICONS[DEFAULT_ICON];
  return (
    <span className="tool-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img" focusable="false">
        <path d={path} />
      </svg>
    </span>
  );
}
