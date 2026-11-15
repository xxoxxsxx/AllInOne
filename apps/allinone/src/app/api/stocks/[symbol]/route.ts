import { getStockConfig, patchStockConfig, StocksAPIError, stocksAPIResponse } from "@/modules/stocks/api";
import { getDB } from "@/modules/stocks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ symbol: string }> };

export async function GET(_request: Request, context: Context) {
  const { symbol } = await context.params;
  return stocksAPIResponse(() => getStockConfig(getDB(), symbol));
}

export async function PATCH(request: Request, context: Context) {
  const { symbol } = await context.params;
  let body: unknown;
  try { body = await request.json(); }
  catch { return stocksAPIResponse(() => { throw new StocksAPIError(400, "Invalid JSON body"); }); }
  return stocksAPIResponse(() => patchStockConfig(getDB(), symbol, body));
}
