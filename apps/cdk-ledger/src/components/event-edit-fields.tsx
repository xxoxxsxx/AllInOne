"use client";

import { useState } from "react";

import type { ResellerPackagePriceOption } from "@/lib/pricing";
import type { EventType } from "@/lib/schema";
import type { EventEditValues } from "@/lib/event-form";
import { buildDateTimeLocalValue } from "@/lib/time";

type SelectOption = {
  code: string;
  cost_price?: string | null;
  fee_fixed_amount?: string | null;
  fee_rate_percent?: string | null;
  name: string;
  sale_price?: string | null;
};

function SelectField(props: {
  label: string;
  name: string;
  options: SelectOption[];
  placeholder: string;
  required?: boolean;
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium text-foreground">{props.label}</span>
      <select
        name={props.name}
        required={props.required}
        defaultValue={props.value ?? ""}
        onChange={(event) => props.onChange?.(event.currentTarget.value)}
        className="h-11 rounded-2xl border border-border bg-white px-4 text-sm outline-none transition focus:border-accent"
      >
        <option value="">{props.placeholder}</option>
        {props.options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.name} ({option.code})
          </option>
        ))}
      </select>
    </label>
  );
}

function InputField(props: {
  defaultValue?: string;
  label: string;
  min?: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  step?: string;
  type?: "text" | "datetime-local" | "number";
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium text-foreground">{props.label}</span>
      <input
        name={props.name}
        required={props.required}
        type={props.type ?? "text"}
        defaultValue={props.defaultValue}
        min={props.min}
        placeholder={props.placeholder}
        step={props.step}
        className="h-11 rounded-2xl border border-border bg-white px-4 text-sm outline-none transition focus:border-accent"
      />
    </label>
  );
}

function TextareaField(props: {
  defaultValue?: string;
  label: string;
  name: string;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium text-foreground">{props.label}</span>
      <textarea
        name={props.name}
        defaultValue={props.defaultValue}
        placeholder={props.placeholder}
        rows={4}
        className="rounded-2xl border border-border bg-white px-4 py-3 text-sm outline-none transition focus:border-accent"
      />
    </label>
  );
}

function formatAmount(value: string | null | undefined) {
  return value ? `${value} 元` : "未配置";
}

function calculatePreviewAmount(
  baseAmount: string | null | undefined,
  ratePercent: string | null | undefined,
  fixedAmount: string | null | undefined,
) {
  if (!baseAmount || ratePercent === null || ratePercent === undefined || !fixedAmount) {
    return null;
  }

  return (
    Number(baseAmount) * Number(ratePercent) / 100 + Number(fixedAmount)
  ).toFixed(2);
}

function PricingSummary(props: {
  kind: EventType;
  packageOption?: SelectOption;
  platformOption?: SelectOption;
  resellerPackagePrice?: ResellerPackagePriceOption;
}) {
  const { kind, packageOption, platformOption, resellerPackagePrice } = props;

  if (kind === "replace" || !packageOption) {
    return null;
  }

  const supplyPrice = resellerPackagePrice?.supply_price ?? null;
  const basePrice = kind === "issue_self" ? packageOption.sale_price : supplyPrice;
  const platformFee = platformOption
    ? calculatePreviewAmount(
        basePrice,
        platformOption.fee_rate_percent,
        platformOption.fee_fixed_amount,
      )
    : kind === "issue_reseller"
      ? "0.00"
      : null;
  const grossProfit = basePrice && platformFee !== null && packageOption.cost_price
    ? (
        Number(basePrice) - Number(packageOption.cost_price) - Number(platformFee)
      ).toFixed(2)
    : null;

  return (
    <div className="sm:col-span-2 rounded-2xl border border-dashed border-border bg-white/60 px-4 py-4 text-sm">
      <p className="font-medium text-foreground">价格预览</p>
      <div className="mt-3 grid gap-2 text-muted sm:grid-cols-2 lg:grid-cols-4">
        <p>成本价：{formatAmount(packageOption.cost_price)}</p>
        <p>{kind === "issue_self" ? "售卖价" : "供货价"}：{formatAmount(basePrice)}</p>
        <p>平台手续费：{formatAmount(platformFee)}</p>
        <p>基础毛利：{formatAmount(grossProfit)}</p>
      </div>
      {!packageOption.cost_price || !basePrice ? (
        <p className="mt-2 text-xs text-amber-700">请先在基础配置中补全适用价格。</p>
      ) : null}
      {kind === "issue_reseller" && !resellerPackagePrice ? (
        <p className="mt-2 text-xs text-amber-700">该下游尚未配置此套餐的供货价。</p>
      ) : null}
    </div>
  );
}

function PriceSnapshotFields(props: {
  kind: EventType;
  values: EventEditValues;
}) {
  if (props.kind !== "issue_self" && props.kind !== "issue_reseller") {
    return null;
  }

  const basePriceLabel = props.kind === "issue_self" ? "售卖价" : "供货价";

  return (
    <div className="sm:col-span-2 rounded-2xl border border-accent/30 bg-accent/5 p-4 sm:p-5">
      <div>
        <p className="text-sm font-semibold text-foreground">历史价格快照</p>
        <p className="mt-1 text-xs leading-6 text-muted">
          这里保存的是当前事件当时的价格。修改套餐、下游或平台配置不会自动带入，留空会清除该事件的价格快照。
        </p>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <InputField
          name="costPrice"
          label="成本价（元）"
          type="number"
          min="0"
          step="0.01"
          defaultValue={props.values.costPrice}
          placeholder="例如 10.00"
        />
        <InputField
          name={props.kind === "issue_self" ? "salePrice" : "supplyPrice"}
          label={`${basePriceLabel}（元）`}
          type="number"
          min="0"
          step="0.01"
          defaultValue={props.kind === "issue_self" ? props.values.salePrice : props.values.supplyPrice}
          placeholder="例如 20.00"
        />
        <InputField
          name="platformFeeRatePercent"
          label="手续费比例（%）"
          type="number"
          min="0"
          step="0.0001"
          defaultValue={props.values.platformFeeRatePercent}
          placeholder="例如 2.5"
        />
        <InputField
          name="platformFeeFixedAmount"
          label="固定手续费（元）"
          type="number"
          min="0"
          step="0.01"
          defaultValue={props.values.platformFeeFixedAmount}
          placeholder="例如 1.00"
        />
        <InputField
          name="platformFeeAmount"
          label="平台手续费（元）"
          type="number"
          min="0"
          step="0.01"
          defaultValue={props.values.platformFeeAmount}
          placeholder="例如 1.50"
        />
      </div>
    </div>
  );
}

export function EventEditFields(props: {
  kind: EventType;
  packages: SelectOption[];
  platforms: SelectOption[];
  resellers: SelectOption[];
  resellerPackagePrices?: ResellerPackagePriceOption[];
  values: EventEditValues;
  mode?: "create" | "update";
  useSubmitTimeDefaults?: boolean;
}) {
  const {
    kind,
    packages,
    platforms,
    resellers,
    resellerPackagePrices = [],
    values,
    mode = "create",
    useSubmitTimeDefaults = false,
  } = props;
  const [packageCode, setPackageCode] = useState(values.packageCode);
  const [platformCode, setPlatformCode] = useState(values.platformCode);
  const [counterpartyCode, setCounterpartyCode] = useState(values.counterpartyCode);
  const packageOption = packages.find((item) => item.code === packageCode);
  const platformOption = platforms.find((item) => item.code === platformCode);
  const resellerPackagePrice = resellerPackagePrices.find(
    (item) =>
      item.package_code === packageCode && item.reseller_code === counterpartyCode,
  );

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <InputField
          name="occurredAt"
          label={useSubmitTimeDefaults ? "录入时间（选填）" : "日期时间"}
          required={!useSubmitTimeDefaults}
          type="datetime-local"
          defaultValue={
            useSubmitTimeDefaults && !values.occurredAt
              ? ""
              : buildDateTimeLocalValue(values.occurredAt)
          }
        />
        {useSubmitTimeDefaults ? (
          <p className="text-xs text-muted">留空时自动使用提交时间。</p>
        ) : null}
      </div>

      {kind === "issue_self" || kind === "issue_reseller" ? (
        <div className="flex flex-col gap-2">
          <InputField
            name="redeemedAt"
            label={useSubmitTimeDefaults ? "兑换时间（选填）" : "兑换时间"}
            required={!useSubmitTimeDefaults}
            type="datetime-local"
            defaultValue={
              useSubmitTimeDefaults && !values.redeemedAt
                ? ""
                : buildDateTimeLocalValue(values.redeemedAt)
            }
          />
          {useSubmitTimeDefaults ? (
            <p className="text-xs text-muted">留空时自动使用提交时间。</p>
          ) : null}
        </div>
      ) : null}

      {kind === "issue_self" || kind === "issue_reseller" || kind === "replace" ? (
        <SelectField
          name="packageCode"
          label="套餐类型"
          options={packages}
          placeholder={packages.length === 0 ? "请先在配置页新增套餐类型" : "选择套餐类型"}
          required
          value={values.packageCode}
          onChange={setPackageCode}
        />
      ) : null}

      {kind === "issue_self" || kind === "replace" ? (
        <SelectField
          name="platformCode"
          label="售卖平台"
          options={platforms}
          placeholder={platforms.length === 0 ? "请先在配置页新增售卖平台" : "选择售卖平台"}
          required
          value={values.platformCode}
          onChange={setPlatformCode}
        />
      ) : null}

      {kind === "issue_reseller" ? (
        <>
          <SelectField
            name="platformCode"
            label="售卖平台"
            options={platforms}
            placeholder="可选，不填则保留为空"
            value={values.platformCode}
            onChange={setPlatformCode}
          />
          <SelectField
            name="counterpartyCode"
            label="下游对象"
            options={resellers}
            placeholder={resellers.length === 0 ? "请先在配置页新增下游对象" : "选择下游对象"}
            required
            value={values.counterpartyCode}
            onChange={setCounterpartyCode}
          />
        </>
      ) : null}

      {kind === "replace" ? (
        <>
          <InputField
            name="cdk"
            label="旧 CDK"
            required
            defaultValue={values.cdk}
            placeholder="输入旧 CDK"
          />
          <InputField
            name="relatedCdk"
            label="新 CDK"
            required
            defaultValue={values.relatedCdk}
            placeholder="输入新 CDK"
          />
        </>
      ) : (
        <InputField
          name="cdk"
          label="CDK"
          required
          defaultValue={values.cdk}
          placeholder="输入 CDK"
        />
      )}

      {mode === "create" ? (
        <PricingSummary
          kind={kind}
          packageOption={packageOption}
          platformOption={platformOption}
          resellerPackagePrice={resellerPackagePrice}
        />
      ) : (
        <PriceSnapshotFields kind={kind} values={values} />
      )}

      <div className="sm:col-span-2">
        <TextareaField
          name="note"
          label="备注"
          defaultValue={values.note}
          placeholder="选填"
        />
      </div>
    </div>
  );
}
