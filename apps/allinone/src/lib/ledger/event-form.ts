import type { ConfigOption } from "@/lib/ledger/config";

export type EventEditValues = {
  cdk: string;
  costPrice: string;
  counterpartyCode: string;
  note: string;
  occurredAt: string;
  packageCode: string;
  platformCode: string;
  platformFeeAmount: string;
  platformFeeFixedAmount: string;
  platformFeeRatePercent: string;
  redeemedAt: string;
  relatedCdk: string;
  salePrice: string;
  supplyPrice: string;
};

export function toEventEditValues(input: {
  cdk?: string | null;
  counterpartyCode?: string | null;
  costPrice?: string | null;
  note?: string | null;
  occurredAt?: string;
  packageCode?: string | null;
  platformCode?: string | null;
  platformFeeAmount?: string | null;
  platformFeeFixedAmount?: string | null;
  platformFeeRatePercent?: string | null;
  redeemedAt?: string | null;
  relatedCdk?: string | null;
  salePrice?: string | null;
  supplyPrice?: string | null;
}): EventEditValues {
  return {
    occurredAt: input.occurredAt ?? "",
    packageCode: input.packageCode ?? "",
    platformCode: input.platformCode ?? "",
    counterpartyCode: input.counterpartyCode ?? "",
    cdk: input.cdk ?? "",
    costPrice: input.costPrice ?? "",
    relatedCdk: input.relatedCdk ?? "",
    redeemedAt: input.redeemedAt ?? "",
    salePrice: input.salePrice ?? "",
    supplyPrice: input.supplyPrice ?? "",
    platformFeeRatePercent: input.platformFeeRatePercent ?? "",
    platformFeeFixedAmount: input.platformFeeFixedAmount ?? "",
    platformFeeAmount: input.platformFeeAmount ?? "",
    note: input.note ?? "",
  };
}

export function withCurrentOption(
  options: ConfigOption[],
  currentCode: string | null,
  currentName: string | null,
) {
  if (!currentCode) {
    return options;
  }

  if (options.some((item) => item.code === currentCode)) {
    return options;
  }

  return [
    {
      code: currentCode,
      name: currentName ? `${currentName}（已停用）` : `${currentCode}（已停用）`,
    },
    ...options,
  ];
}
