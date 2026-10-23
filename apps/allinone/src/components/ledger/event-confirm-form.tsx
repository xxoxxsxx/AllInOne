"use client";

import { useRef, useState } from "react";

import { eventTypeLabels, type EventType } from "@/lib/ledger/schema";

type EventConfirmFormProps = {
  action: (formData: FormData) => void | Promise<void>;
  children: React.ReactNode;
  initialValues?: Record<string, string>;
  kind: EventType;
  mode: "create" | "update";
};

type SummaryItem = {
  label: string;
  value: string;
};

function getInputValue(form: HTMLFormElement, name: string) {
  const element = form.elements.namedItem(name);

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return element.value.trim();
  }

  return "";
}

function getSelectText(form: HTMLFormElement, name: string) {
  const element = form.elements.namedItem(name);

  if (!(element instanceof HTMLSelectElement)) {
    return "";
  }

  return element.selectedOptions[0]?.text.trim() ?? "";
}

function formatValue(value: string) {
  return value || "-";
}

function formatCreateTime(value: string) {
  return value || "提交时自动记录";
}

function toTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function getCreateSummary(form: HTMLFormElement, kind: EventType) {
  const items: SummaryItem[] = [
    {
      label: "事件类型",
      value: eventTypeLabels[kind],
    },
    {
      label: "录入时间",
      value: formatCreateTime(getInputValue(form, "occurredAt")),
    },
  ];

  if (kind === "issue_self" || kind === "issue_reseller") {
    items.push({
      label: "兑换时间",
      value: formatCreateTime(getInputValue(form, "redeemedAt")),
    });
  }

  if (kind === "issue_self" || kind === "issue_reseller" || kind === "replace") {
    items.push({
      label: "套餐类型",
      value: formatValue(getSelectText(form, "packageCode")),
    });
  }

  if (kind === "issue_self" || kind === "replace") {
    items.push({
      label: "售卖平台",
      value: formatValue(getSelectText(form, "platformCode")),
    });
  }

  if (kind === "issue_reseller") {
    const platform = getSelectText(form, "platformCode");

    if (platform) {
      items.push({
        label: "售卖平台",
        value: platform,
      });
    }

    items.push({
      label: "下游对象",
      value: formatValue(getSelectText(form, "counterpartyCode")),
    });
  }

  if (kind === "replace") {
    items.push(
      {
        label: "旧 CDK",
        value: formatValue(getInputValue(form, "cdk")),
      },
      {
        label: "新 CDK",
        value: formatValue(getInputValue(form, "relatedCdk")),
      },
    );
  } else {
    items.push({
      label: "当前 CDK",
      value: formatValue(getInputValue(form, "cdk")),
    });
  }

  const note = getInputValue(form, "note");

  if (note) {
    items.push({
      label: "备注",
      value: note,
    });
  }

  return items;
}

function getUpdateSummary(
  form: HTMLFormElement,
  kind: EventType,
  initialValues: Record<string, string>,
) {
  const nextValues = {
    occurredAt: getInputValue(form, "occurredAt"),
    packageCode: getInputValue(form, "packageCode"),
    platformCode: getInputValue(form, "platformCode"),
    counterpartyCode: getInputValue(form, "counterpartyCode"),
    cdk: getInputValue(form, "cdk"),
    redeemedAt: getInputValue(form, "redeemedAt"),
    relatedCdk: getInputValue(form, "relatedCdk"),
    note: getInputValue(form, "note"),
    costPrice: getInputValue(form, "costPrice"),
    salePrice: getInputValue(form, "salePrice"),
    supplyPrice: getInputValue(form, "supplyPrice"),
    platformFeeRatePercent: getInputValue(form, "platformFeeRatePercent"),
    platformFeeFixedAmount: getInputValue(form, "platformFeeFixedAmount"),
    platformFeeAmount: getInputValue(form, "platformFeeAmount"),
  };

  const nextLabels = {
    packageCode: getSelectText(form, "packageCode"),
    platformCode: getSelectText(form, "platformCode"),
    counterpartyCode: getSelectText(form, "counterpartyCode"),
  };

  const fields: Array<{
    label: string;
    name: keyof typeof nextValues;
    textValue?: string;
  }> = [
    { label: "日期时间", name: "occurredAt" },
    ...(kind === "issue_self" || kind === "issue_reseller"
      ? [{ label: "兑换时间", name: "redeemedAt" as const }]
      : []),
    ...(kind === "issue_self" || kind === "issue_reseller" || kind === "replace"
      ? [{ label: "套餐类型", name: "packageCode" as const, textValue: nextLabels.packageCode }]
      : []),
    ...(kind === "issue_self" || kind === "issue_reseller" || kind === "replace"
      ? [{ label: "售卖平台", name: "platformCode" as const, textValue: nextLabels.platformCode }]
      : []),
    ...(kind === "issue_reseller"
      ? [
          {
            label: "下游对象",
            name: "counterpartyCode" as const,
            textValue: nextLabels.counterpartyCode,
          },
        ]
      : []),
    { label: kind === "replace" ? "旧 CDK" : "CDK", name: "cdk" },
    ...(kind === "replace" ? [{ label: "新 CDK", name: "relatedCdk" as const }] : []),
    { label: "备注", name: "note" },
    ...(kind === "issue_self" || kind === "issue_reseller"
      ? [
          { label: "成本价", name: "costPrice" as const },
          ...(kind === "issue_self"
            ? [{ label: "售卖价", name: "salePrice" as const }]
            : [{ label: "供货价", name: "supplyPrice" as const }]),
          { label: "手续费比例", name: "platformFeeRatePercent" as const },
          { label: "固定手续费", name: "platformFeeFixedAmount" as const },
          { label: "平台手续费", name: "platformFeeAmount" as const },
        ]
      : []),
  ];

  const items = fields
    .filter((field) => {
      const currentValue = toTrimmedString(initialValues[field.name]);
      const nextValue = toTrimmedString(nextValues[field.name]);
      return currentValue !== nextValue;
    })
    .map((field) => {
      const currentValue = toTrimmedString(initialValues[field.name]);
      const nextValue = toTrimmedString(nextValues[field.name]);

      return {
        label: field.label,
        value: `${formatValue(currentValue)} -> ${formatValue(field.textValue ?? nextValue)}`,
      };
    });

  if (items.length === 0) {
    return [
      {
        label: "变更内容",
        value: "未检测到字段变化。",
      },
    ];
  }

  return items;
}

export function EventConfirmForm({
  action,
  children,
  initialValues,
  kind,
  mode,
}: EventConfirmFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const skipConfirmRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SummaryItem[]>([]);

  return (
    <>
      <form
        ref={formRef}
        action={action}
        onSubmit={(event) => {
          if (skipConfirmRef.current) {
            skipConfirmRef.current = false;
            return;
          }

          event.preventDefault();

          const form = event.currentTarget;
          const nextItems =
            mode === "create"
              ? getCreateSummary(form, kind)
              : getUpdateSummary(form, kind, initialValues ?? {});

          setItems(nextItems);
          setOpen(true);
        }}
      >
        {children}
      </form>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-950/45 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:items-center sm:p-4">
          <div className="flex max-h-[calc(100dvh-1.5rem-env(safe-area-inset-bottom))] w-full max-w-xl flex-col overflow-hidden rounded-[28px] border border-border bg-surface shadow-[0_24px_80px_rgba(15,23,42,0.22)] sm:max-h-[calc(100dvh-2rem)]">
            <div className="shrink-0 px-5 pt-5 sm:px-7 sm:pt-7">
              <p className="text-sm uppercase tracking-[0.24em] text-accent">
                {mode === "create" ? "Confirm Create" : "Confirm Update"}
              </p>
              <h3 className="mt-2 text-2xl font-semibold tracking-tight">
                {mode === "create" ? "确认提交事件" : "确认保存修改"}
              </h3>
              <p className="mt-3 text-sm leading-7 text-muted">
                {mode === "create"
                  ? "请再次确认本次录入内容，尤其是当前 CDK。"
                  : "请再次确认本次修改内容，高风险字段请重点核对。"}
              </p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
              <div className="space-y-3">
                {items.map((item) => (
                  <div
                    key={`${item.label}-${item.value}`}
                    className="rounded-2xl border border-border bg-white/85 p-4"
                  >
                    <p className="text-xs uppercase tracking-[0.2em] text-accent">
                      {item.label}
                    </p>
                    <p className="mt-2 break-words text-sm leading-7 text-foreground">
                      {item.value}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="shrink-0 border-t border-border bg-surface px-5 py-4 sm:px-7">
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-11 items-center justify-center rounded-2xl border border-border px-5 text-sm text-foreground transition hover:border-accent hover:text-accent"
                >
                  返回检查
                </button>
                <button
                  type="button"
                  onClick={() => {
                    skipConfirmRef.current = true;
                    setOpen(false);
                    formRef.current?.requestSubmit();
                  }}
                  className="inline-flex h-11 items-center justify-center rounded-2xl bg-accent px-5 text-sm font-medium text-white transition hover:opacity-90"
                >
                  {mode === "create" ? "确认录入" : "确认保存"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
