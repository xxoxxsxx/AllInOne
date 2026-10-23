"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  createIssueReseller,
  createIssueSelf,
  createReplace,
  createVoid,
  isEventKind,
  toEventSuccessMessage,
} from "@/lib/events";
import type { EventType } from "@/lib/schema";
import { getCurrentShanghaiDateTimeLocal } from "@/lib/time";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function buildSearch(input: Record<string, string | undefined>) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(input)) {
    if (value) {
      search.set(key, value);
    }
  }

  return search.toString();
}

function redirectToForm(
  kind: EventType,
  status: {
    error?: string;
    message?: string;
  },
) {
  const query = buildSearch({
    type: kind,
    error: status.error,
    message: status.message,
  });

  redirect(`/events/new?${query}`);
}

function getKind(formData: FormData) {
  const value = getString(formData, "kind");

  if (!isEventKind(value) || value === "refund") {
    throw new Error("不支持的事件类型。");
  }

  return value;
}

export async function createEventAction(formData: FormData) {
  const kind = getKind(formData);
  const savedAt = getCurrentShanghaiDateTimeLocal();
  const occurredAt = getString(formData, "occurredAt") || savedAt;
  const redeemedAt = getString(formData, "redeemedAt") || savedAt;
  let errorMessage: string | undefined;

  try {
    if (kind === "issue_self") {
      await createIssueSelf({
        occurredAt,
        redeemedAt,
        packageCode: getString(formData, "packageCode"),
        platformCode: getString(formData, "platformCode"),
        cdk: getString(formData, "cdk"),
        note: getString(formData, "note"),
      });
    }

    if (kind === "issue_reseller") {
      await createIssueReseller({
        occurredAt,
        redeemedAt,
        counterpartyCode: getString(formData, "counterpartyCode"),
        packageCode: getString(formData, "packageCode"),
        platformCode: getString(formData, "platformCode"),
        cdk: getString(formData, "cdk"),
        note: getString(formData, "note"),
      });
    }

    if (kind === "void") {
      await createVoid({
        occurredAt,
        cdk: getString(formData, "cdk"),
        note: getString(formData, "note"),
      });
    }

    if (kind === "replace") {
      await createReplace({
        occurredAt,
        packageCode: getString(formData, "packageCode"),
        platformCode: getString(formData, "platformCode"),
        oldCdk: getString(formData, "cdk"),
        newCdk: getString(formData, "relatedCdk"),
        note: getString(formData, "note"),
      });
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "提交失败。";
  }

  if (errorMessage) {
    redirectToForm(kind, { error: errorMessage });
  }

  revalidatePath("/events/new");
  revalidatePath("/");
  redirectToForm(kind, { message: toEventSuccessMessage(kind) });
}
