import {
  deleteResellerPackagePriceAction,
  upsertResellerPackagePriceAction,
} from "@/app/(ledger)/config/actions";
import type { ConfigListItem } from "@/lib/ledger/config";
import type { ResellerPackagePrice } from "@/lib/ledger/pricing";

type ResellerPackagePriceMatrixProps = {
  packages: ConfigListItem[];
  prices: ResellerPackagePrice[];
  resellers: ConfigListItem[];
};

function formatPrice(value: string | undefined) {
  return value ? `${value} 元` : "未配置";
}

export function ResellerPackagePriceMatrix({
  packages,
  prices,
  resellers,
}: ResellerPackagePriceMatrixProps) {
  const priceMap = new Map(
    prices.map((price) => [
      `${price.reseller_code}:${price.package_code}`,
      price,
    ]),
  );

  return (
    <section className="rounded-xl border border-border bg-surface p-5 shadow-[0_8px_24px_rgba(15,23,42,0.04)] sm:p-7">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">Pricing matrix</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">下游套餐供货价</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
          维护每个下游对应套餐的供货价。没有配置的组合不能新增下游代发事件。
        </p>
      </div>

      {packages.length === 0 || resellers.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-border px-4 py-5 text-sm text-muted">
          请先新增套餐类型和下游对象。
        </div>
      ) : (
        <div className="mt-5 overflow-x-auto rounded-lg border border-border bg-white">
          <table className="min-w-[720px] w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-stone-50 text-muted">
                <th className="sticky left-0 bg-stone-50 px-4 py-3 font-medium">下游对象</th>
                {packages.map((item) => (
                  <th key={item.code} className="min-w-44 px-4 py-3 font-medium">
                    {item.name}
                    <span className="mt-1 block text-xs font-normal">{item.code}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resellers.map((reseller) => (
                <tr key={reseller.code} className="border-b border-border last:border-b-0">
                  <th className="whitespace-nowrap px-4 py-4 align-top font-medium text-foreground">
                    {reseller.name}
                    <span className="mt-1 block text-xs font-normal text-muted">
                      {reseller.code}
                    </span>
                  </th>
                  {packages.map((item) => {
                    const price = priceMap.get(`${reseller.code}:${item.code}`);

                    return (
                      <td key={item.code} className="px-4 py-4 align-top">
                        <form action={upsertResellerPackagePriceAction} className="space-y-2">
                          <input type="hidden" name="resellerCode" value={reseller.code} />
                          <input type="hidden" name="packageCode" value={item.code} />
                          <input
                            name="supplyPrice"
                            type="number"
                            min="0"
                            step="0.01"
                            required
                            defaultValue={price?.supply_price ?? ""}
                            placeholder={formatPrice(price?.supply_price)}
                            className="h-10 w-full rounded-lg border border-border bg-stone-50 px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              type="submit"
                              className="h-9 whitespace-nowrap rounded-lg bg-accent px-3 text-xs font-semibold text-white transition hover:bg-accent/90"
                            >
                              保存
                            </button>
                            {price ? (
                              <button
                                formAction={deleteResellerPackagePriceAction}
                                type="submit"
                                className="h-9 whitespace-nowrap rounded-lg border border-rose-200 px-3 text-xs text-rose-700 transition hover:bg-rose-50"
                              >
                                删除
                              </button>
                            ) : null}
                          </div>
                        </form>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
