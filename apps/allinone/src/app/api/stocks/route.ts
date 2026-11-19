import { createStockConfig, listStockConfigs, StocksAPIError, stocksAPIResponse } from "@/modules/stocks/api";
import { getDB } from "@/modules/stocks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return stocksAPIResponse(() => { throw new StocksAPIError(400, "Invalid JSON body"); }); }
  return stocksAPIResponse(() => createStockConfig(getDB(), body));
}

export async function GET() {
  return stocksAPIResponse(() => ({ stocks: listStockConfigs(getDB()) }));
}
