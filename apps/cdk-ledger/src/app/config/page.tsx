import Link from "next/link";

import { ConfigSection } from "@/components/config-section";
import { ResellerPackagePriceMatrix } from "@/components/reseller-package-price-matrix";
import { listConfigItems } from "@/lib/config";
import { listResellerPackagePrices } from "@/lib/pricing";

export const dynamic = "force-dynamic";

export default async function ConfigPage() {
  const [packages, resellers, platforms, prices] = await Promise.all([
    listConfigItems("package"),
    listConfigItems("reseller"),
    listConfigItems("platform"),
    listResellerPackagePrices(),
  ]);

  return (
    <main className="min-h-screen px-4 py-6 sm:px-8 sm:py-10">
      <div className="mx-auto flex w-full max-w-7xl flex-col">
        <header className="border-b border-border pb-7">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-accent">
                Control center / 04
              </p>
              <h1 className="mt-3 font-serif text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
                基础配置
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-muted sm:text-base">
                集中维护套餐价格、下游供货价和售卖平台手续费。配置只影响后续新增事件，历史快照不会被改写。
              </p>
            </div>

            <Link
              href="/"
              className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface px-4 text-sm font-medium text-foreground transition hover:border-accent hover:text-accent"
            >
              返回首页
            </Link>
          </div>

          <div className="mt-7 grid max-w-2xl grid-cols-3 divide-x divide-border border-y border-border py-4">
            <div className="pr-4">
              <p className="text-xs text-muted">套餐类型</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{packages.length}</p>
            </div>
            <div className="px-4">
              <p className="text-xs text-muted">下游对象</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{resellers.length}</p>
            </div>
            <div className="pl-4">
              <p className="text-xs text-muted">售卖平台</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{platforms.length}</p>
            </div>
          </div>
        </header>

        <div className="mt-8 flex flex-col gap-6">
          <ConfigSection
            kind="package"
            title="套餐类型"
            description="用于自营发货、下游代发和换新事件。为套餐补充成本价和标准售卖价后，才能新增发货事件。"
            emptyHint="当前还没有套餐类型，请先新增。"
            items={packages}
          />
          <ConfigSection
            kind="reseller"
            title="下游对象"
            description="用于下游代发事件。下游与套餐的供货价在下方单独维护。"
            emptyHint="当前还没有下游对象，请按实际业务新增。"
            items={resellers}
          />
          <ConfigSection
            kind="platform"
            title="售卖平台"
            description="维护平台费率和固定手续费。新增事件时会按对应的售卖平台保存手续费快照。"
            emptyHint="当前还没有售卖平台，请先按实际业务新增。"
            items={platforms}
          />
          <ResellerPackagePriceMatrix
            packages={packages}
            resellers={resellers}
            prices={prices}
          />
        </div>
      </div>
    </main>
  );
}
