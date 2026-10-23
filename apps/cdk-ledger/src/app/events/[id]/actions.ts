"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { updateEvent } from "@/lib/events";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function redirectToEvent(id: string, input: {
  error?: string;
  message?: string;
}) {
  const search = new URLSearchParams();

  if (input.message) {
    search.set("message", input.message);
  }

  if (input.error) {
    search.set("error", input.error);
  }

  const query = search.toString();
  redirect(query ? `/events/${id}?${query}` : `/events/${id}`);
}

export async function updateEventAction(formData: FormData) {
  const id = getString(formData, "id").trim();
  let errorMessage: string | undefined;
  let message = "事件已更新。";

  try {
    const changed = await updateEvent({
      id,
      occurredAt: getString(formData, "occurredAt"),
      redeemedAt: getString(formData, "redeemedAt"),
      packageCode: getString(formData, "packageCode"),
      platformCode: getString(formData, "platformCode"),
      counterpartyCode: getString(formData, "counterpartyCode"),
      costPrice: getString(formData, "costPrice"),
      salePrice: getString(formData, "salePrice"),
      supplyPrice: getString(formData, "supplyPrice"),
      platformFeeRatePercent: getString(formData, "platformFeeRatePercent"),
      platformFeeFixedAmount: getString(formData, "platformFeeFixedAmount"),
      platformFeeAmount: getString(formData, "platformFeeAmount"),
      cdk: getString(formData, "cdk"),
      relatedCdk: getString(formData, "relatedCdk"),
      note: getString(formData, "note"),
    });

    if (!changed) {
      message = "未检测到字段变化。";
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "事件更新失败。";
  }

  if (errorMessage) {
    redirectToEvent(id, { error: errorMessage });
  }

  revalidatePath("/");
  revalidatePath("/events");
  revalidatePath(`/events/${id}`);
  redirectToEvent(id, { message });
}

export async function saveRefundAction(formData: FormData) {
  const { saveRefund } = await import("@/lib/refunds");
  const id = getString(formData, "id");
  const sourceId = getString(formData, "sourceId");
  const editing = getString(formData, "editing") === "1";
  try {
    await saveRefund({
      id, sourceId, editing,
      occurredAt: getString(formData, "occurredAt"),
      refundAmount: getString(formData, "refundAmount"),
      costReturned: getString(formData, "costReturned"),
      feeReturned: getString(formData, "feeReturned"),
      note: getString(formData, "note"),
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return { error: "同一 CDK 在该时间已有退款记录，请打开已有记录修改，或核对本次退款时间。" };
    }
    return { error: error instanceof Error ? error.message : "退款保存失败。" };
  }
  revalidatePath("/");
  revalidatePath("/events");
  revalidatePath(`/events/${sourceId}`);
  revalidatePath(`/events/${id}`);
  redirectToEvent(id, { message: "退款/退回已记录并计入毛利；CDK 状态不变，需作废时请另行登记作废。" });
}
