"use client";

import { useState } from "react";

import type { EventType } from "@/lib/schema";

const cdkPattern = /[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}/g;

function extractCdks(input: string) {
  const matches = input.toUpperCase().match(cdkPattern) ?? [];
  return [...new Set(matches)];
}

function setInputValue(
  form: HTMLFormElement,
  name: "cdk" | "relatedCdk",
  value: string,
) {
  const input = form.elements.namedItem(name);

  if (!(input instanceof HTMLInputElement)) {
    return false;
  }

  input.value = value;
  return true;
}

function applyDetectedCdks(
  kind: EventType,
  form: HTMLFormElement | null,
  input: string,
) {
  const cdks = extractCdks(input);

  if (!form) {
    return "未找到表单，无法自动填入。";
  }

  if (cdks.length === 0) {
    return input.trim() ? "未识别到可用 CDK。" : "支持直接粘贴整段兑换信息。";
  }

  if (kind === "replace") {
    setInputValue(form, "cdk", cdks[0] ?? "");

    if (cdks[1]) {
      setInputValue(form, "relatedCdk", cdks[1]);
      return `已识别 ${cdks.length} 个 CDK，并填入旧/新 CDK。`;
    }

    return "已识别 1 个 CDK，并填入旧 CDK。";
  }

  setInputValue(form, "cdk", cdks[0] ?? "");

  return cdks.length > 1
    ? `已识别 ${cdks.length} 个 CDK，已填入第一个。`
    : "已识别 1 个 CDK，并填入输入框。";
}

export function CdkPasteBox({ kind }: { kind: EventType }) {
  const [value, setValue] = useState("");
  const [message, setMessage] = useState("支持直接粘贴整段兑换信息。");

  return (
    <label className="flex flex-col gap-2 rounded-2xl border border-dashed border-border bg-white/70 px-4 py-4">
      <span className="text-sm font-medium text-foreground">智能识别框</span>
      <textarea
        value={value}
        rows={4}
        placeholder="粘贴整段文本，例如：兑换码、兑换地址、使用方法。"
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          setValue(nextValue);
          setMessage(applyDetectedCdks(kind, event.currentTarget.form, nextValue));
        }}
        className="rounded-2xl border border-border bg-white px-4 py-3 text-sm leading-7 outline-none transition focus:border-accent"
      />
      <p className="text-sm text-muted">{message}</p>
    </label>
  );
}
