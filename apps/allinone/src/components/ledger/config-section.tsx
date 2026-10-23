import {
  createConfigAction,
  deleteConfigAction,
  setConfigDefaultAction,
  toggleConfigAction,
  updateConfigPricingAction,
} from "@/app/(ledger)/config/actions";
import type { ConfigKind, ConfigListItem } from "@/lib/ledger/config";

type ConfigSectionProps = {
  description: string;
  emptyHint: string;
  items: ConfigListItem[];
  kind: ConfigKind;
  title: string;
};

function formatDateTime(value: string | null) {
  if (!value) {
    return "未更新";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function getCodePlaceholder(kind: ConfigKind) {
  if (kind === "package") {
    return "例如 5xpro";
  }

  if (kind === "reseller") {
    return "例如 alpha-team";
  }

  return "例如 taobao";
}

function getNamePlaceholder(kind: ConfigKind) {
  if (kind === "package") {
    return "例如 5xpro";
  }

  if (kind === "reseller") {
    return "例如 Alpha Team";
  }

  return "例如 淘宝";
}

function formatMoney(value: string | null | undefined) {
  return value ? `${value} 元` : "未配置";
}

export function ConfigSection({
  description,
  emptyHint,
  items,
  kind,
  title,
}: ConfigSectionProps) {
  return (
    <section className="rounded-xl border border-border bg-surface p-5 shadow-[0_8px_24px_rgba(15,23,42,0.04)] sm:p-7">
      <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">
            Configuration
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
            {description}
          </p>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted">{items.length} 项配置</span>
      </div>

      <form
        action={createConfigAction}
        className={
          kind === "package" || kind === "platform"
            ? "mt-5 grid gap-3 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
            : "mt-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]"
        }
      >
        <input type="hidden" name="kind" value={kind} />
          <label className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">编码</span>
          <input
            name="code"
            required
            placeholder={getCodePlaceholder(kind)}
            className="h-11 rounded-lg border border-border bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
          />
        </label>
        {kind === "package" ? (
          <>
            <label className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">成本价（元）</span>
              <input
                name="costPrice"
                type="number"
                min="0"
                step="0.01"
                placeholder="可后续补录"
                className="h-11 rounded-lg border border-border bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">售卖价（元）</span>
              <input
                name="salePrice"
                type="number"
                min="0"
                step="0.01"
                placeholder="可后续补录"
                className="h-11 rounded-lg border border-border bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
              />
            </label>
          </>
        ) : null}
        {kind === "platform" ? (
          <>
            <label className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">手续费比例（%）</span>
              <input
                name="feeRatePercent"
                type="number"
                min="0"
                step="0.0001"
                defaultValue="0"
                required
                className="h-11 rounded-lg border border-border bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">固定手续费（元）</span>
              <input
                name="feeFixedAmount"
                type="number"
                min="0"
                step="0.01"
                defaultValue="0"
                required
                className="h-11 rounded-lg border border-border bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
              />
            </label>
          </>
        ) : null}
        <label className="flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">名称</span>
          <input
            name="name"
            required
            placeholder={getNamePlaceholder(kind)}
            className="h-11 rounded-lg border border-border bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
          />
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            className="h-11 w-full rounded-lg bg-accent px-5 text-sm font-semibold text-white transition hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent/30 sm:w-auto"
          >
            新增
          </button>
        </div>
      </form>

      <p className="mt-3 text-xs leading-6 text-muted">
        编码会自动转成小写，空格会转成短横线。首版不支持修改编码。
      </p>

      <div className="mt-5 space-y-3">
        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border px-4 py-5 text-sm text-muted">
            {emptyHint}
          </div>
        ) : null}

        {items.map((item) => (
          <article
            key={item.code}
            className="rounded-lg border border-border bg-white p-4 sm:p-5"
          >
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold tracking-tight text-foreground">
                    {item.name}
                  </h3>
                  <span className="rounded-md bg-stone-100 px-2 py-1 text-xs text-muted">
                    {item.code}
                  </span>
                  <span
                    className={
                      item.is_active
                        ? "rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-700"
                        : "rounded-md bg-stone-100 px-2 py-1 text-xs text-stone-600"
                    }
                  >
                    {item.is_active ? "启用中" : "已停用"}
                  </span>
                  {item.is_default ? (
                    <span className="rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-700">
                      默认项
                    </span>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
                  <p>引用 {item.reference_count} 次</p>
                  <p>创建于 {formatDateTime(item.created_at)}</p>
                  <p>更新于 {formatDateTime(item.updated_at)}</p>
                </div>

                {kind === "package" ? (
                  <form
                    action={updateConfigPricingAction}
                    className="mt-5 grid gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end"
                  >
                    <input type="hidden" name="kind" value={kind} />
                    <input type="hidden" name="code" value={item.code} />
                    <label className="flex flex-col gap-2">
                      <span className="text-xs font-medium text-muted">成本价（元）</span>
                      <input
                        name="costPrice"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue={item.cost_price ?? ""}
                        placeholder={formatMoney(item.cost_price)}
                        className="h-10 rounded-lg border border-border bg-stone-50 px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
                      />
                    </label>
                    <label className="flex flex-col gap-2">
                      <span className="text-xs font-medium text-muted">售卖价（元）</span>
                      <input
                        name="salePrice"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue={item.sale_price ?? ""}
                        placeholder={formatMoney(item.sale_price)}
                        className="h-10 rounded-lg border border-border bg-stone-50 px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
                      />
                    </label>
                    <button
                      type="submit"
                      className="h-10 whitespace-nowrap rounded-lg border border-accent px-4 text-sm font-semibold text-accent transition hover:bg-accent hover:text-white"
                    >
                      保存价格
                    </button>
                  </form>
                ) : null}

                {kind === "platform" ? (
                  <form
                    action={updateConfigPricingAction}
                    className="mt-5 grid gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end"
                  >
                    <input type="hidden" name="kind" value={kind} />
                    <input type="hidden" name="code" value={item.code} />
                    <label className="flex flex-col gap-2">
                      <span className="text-xs font-medium text-muted">手续费比例（%）</span>
                      <input
                        name="feeRatePercent"
                        type="number"
                        min="0"
                        step="0.0001"
                        required
                        defaultValue={item.fee_rate_percent ?? "0"}
                        className="h-10 rounded-lg border border-border bg-stone-50 px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
                      />
                    </label>
                    <label className="flex flex-col gap-2">
                      <span className="text-xs font-medium text-muted">固定手续费（元）</span>
                      <input
                        name="feeFixedAmount"
                        type="number"
                        min="0"
                        step="0.01"
                        required
                        defaultValue={item.fee_fixed_amount ?? "0"}
                        className="h-10 rounded-lg border border-border bg-stone-50 px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
                      />
                    </label>
                    <button
                      type="submit"
                      className="h-10 whitespace-nowrap rounded-lg border border-accent px-4 text-sm font-semibold text-accent transition hover:bg-accent hover:text-white"
                    >
                      保存手续费
                    </button>
                  </form>
                ) : null}
              </div>

              <div className="flex flex-row flex-wrap gap-2 lg:max-w-64 lg:justify-end">
                <form action={setConfigDefaultAction}>
                  <input type="hidden" name="kind" value={kind} />
                  <input type="hidden" name="code" value={item.code} />
                  <button
                    type="submit"
                    disabled={item.is_default}
                    className="h-9 whitespace-nowrap rounded-lg border border-amber-200 px-3 text-sm text-amber-700 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:text-stone-400 disabled:hover:bg-transparent"
                  >
                    {item.is_default ? "当前默认" : "设为默认"}
                  </button>
                </form>

                <form action={toggleConfigAction}>
                  <input type="hidden" name="kind" value={kind} />
                  <input type="hidden" name="code" value={item.code} />
                  <input
                    type="hidden"
                    name="next_state"
                    value={item.is_active ? "false" : "true"}
                  />
                  <button
                    type="submit"
                    className="h-9 whitespace-nowrap rounded-lg border border-border px-3 text-sm text-foreground transition hover:border-accent hover:text-accent"
                  >
                    {item.is_active ? "停用" : "启用"}
                  </button>
                </form>

                <form action={deleteConfigAction}>
                  <input type="hidden" name="kind" value={kind} />
                  <input type="hidden" name="code" value={item.code} />
                  <button
                    type="submit"
                    disabled={item.reference_count > 0}
                    className="h-9 whitespace-nowrap rounded-lg border border-rose-200 px-3 text-sm text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:text-stone-400 disabled:hover:bg-transparent"
                  >
                    删除
                  </button>
                </form>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
