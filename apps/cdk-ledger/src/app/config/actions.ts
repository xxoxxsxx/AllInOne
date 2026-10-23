"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  createConfigItem,
  deleteConfigItem,
  parseConfigKind,
  setConfigItemActive,
  setConfigItemDefault,
  updateConfigPricing,
} from "@/lib/config";
import {
  deleteResellerPackagePrice,
  upsertResellerPackagePrice,
} from "@/lib/pricing";
import { withBase } from "@/lib/base-path";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function redirectToConfig(input: {
  message?: string;
  error?: string;
}) {
  const search = new URLSearchParams();

  if (input.message) {
    search.set("message", input.message);
  }

  if (input.error) {
    search.set("error", input.error);
  }

  const query = search.toString();
  redirect(query ? withBase(`/config?${query}`) : withBase("/config"));
}

export async function createConfigAction(formData: FormData) {
  const kind = parseConfigKind(getString(formData, "kind"));
  const code = getString(formData, "code");
  const name = getString(formData, "name");
  let errorMessage: string | undefined;

  try {
    await createConfigItem(kind, {
      code,
      costPrice: getString(formData, "costPrice"),
      feeFixedAmount: getString(formData, "feeFixedAmount"),
      feeRatePercent: getString(formData, "feeRatePercent"),
      name,
      salePrice: getString(formData, "salePrice"),
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "新增失败。";
  }

  if (errorMessage) {
    redirectToConfig({ error: errorMessage });
  }

  revalidatePath("/config");
  revalidatePath("/events/new");
  redirectToConfig({ message: "配置项已新增。" });
}

export async function updateConfigPricingAction(formData: FormData) {
  const kind = parseConfigKind(getString(formData, "kind"));
  const code = getString(formData, "code");
  let errorMessage: string | undefined;

  try {
    await updateConfigPricing(kind, {
      code,
      costPrice: getString(formData, "costPrice"),
      feeFixedAmount: getString(formData, "feeFixedAmount"),
      feeRatePercent: getString(formData, "feeRatePercent"),
      salePrice: getString(formData, "salePrice"),
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "价格更新失败。";
  }

  if (errorMessage) {
    redirectToConfig({ error: errorMessage });
  }

  revalidatePath("/config");
  revalidatePath("/events/new");
  redirectToConfig({ message: "价格配置已更新。" });
}

export async function toggleConfigAction(formData: FormData) {
  const kind = parseConfigKind(getString(formData, "kind"));
  const code = getString(formData, "code");
  const nextState = getString(formData, "next_state") === "true";
  let errorMessage: string | undefined;

  try {
    await setConfigItemActive(kind, {
      code,
      isActive: nextState,
    });
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "状态更新失败。";
  }

  if (errorMessage) {
    redirectToConfig({ error: errorMessage });
  }

  revalidatePath("/config");
  revalidatePath("/events/new");
  redirectToConfig({ message: "状态已更新。" });
}

export async function setConfigDefaultAction(formData: FormData) {
  const kind = parseConfigKind(getString(formData, "kind"));
  const code = getString(formData, "code");
  let errorMessage: string | undefined;

  try {
    await setConfigItemDefault(kind, { code });
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "默认项更新失败。";
  }

  if (errorMessage) {
    redirectToConfig({ error: errorMessage });
  }

  revalidatePath("/config");
  revalidatePath("/events/new");
  redirectToConfig({ message: "默认项已更新。" });
}

export async function deleteConfigAction(formData: FormData) {
  const kind = parseConfigKind(getString(formData, "kind"));
  const code = getString(formData, "code");
  let errorMessage: string | undefined;

  try {
    await deleteConfigItem(kind, { code });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "删除失败。";
  }

  if (errorMessage) {
    redirectToConfig({ error: errorMessage });
  }

  revalidatePath("/config");
  revalidatePath("/events/new");
  redirectToConfig({ message: "配置项已删除。" });
}

export async function upsertResellerPackagePriceAction(formData: FormData) {
  let errorMessage: string | undefined;

  try {
    await upsertResellerPackagePrice({
      packageCode: getString(formData, "packageCode"),
      resellerCode: getString(formData, "resellerCode"),
      supplyPrice: getString(formData, "supplyPrice"),
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "供货价更新失败。";
  }

  if (errorMessage) {
    redirectToConfig({ error: errorMessage });
  }

  revalidatePath("/config");
  revalidatePath("/events/new");
  redirectToConfig({ message: "供货价已保存。" });
}

export async function deleteResellerPackagePriceAction(formData: FormData) {
  let errorMessage: string | undefined;

  try {
    await deleteResellerPackagePrice({
      packageCode: getString(formData, "packageCode"),
      resellerCode: getString(formData, "resellerCode"),
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "供货价删除失败。";
  }

  if (errorMessage) {
    redirectToConfig({ error: errorMessage });
  }

  revalidatePath("/config");
  revalidatePath("/events/new");
  redirectToConfig({ message: "供货价已删除。" });
}
