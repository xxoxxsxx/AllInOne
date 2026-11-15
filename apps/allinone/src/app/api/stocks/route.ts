import { listStockConfigs, stocksAPIResponse } from "@/modules/stocks/api";
import { getDB } from "@/modules/stocks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return stocksAPIResponse(() => ({ stocks: listStockConfigs(getDB()) }));
}
