"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  Account,
  Batch,
  Transfer,
  Goal,
  Summary,
  Change,
} from "@/lib/funding/types";

const API = "/api/funding/v1";
// getRandomValues also works on plain HTTP LAN origins, unlike randomUUID.
function requestKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
function display(value: string = "0") {
  const n = BigInt(value);
  return `${(n / 100n).toLocaleString("zh-CN")}.${(n % 100n).toString().padStart(2, "0")}`;
}
function minor(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw new Error("金额须为非负数，最多两位小数");
  const [a, b = ""] = value.split(".");
  return (BigInt(a) * 100n + BigInt(b.padEnd(2, "0"))).toString();
}
function decimal(value: string) {
  return display(value).replaceAll(",", "");
}
const statusText: Record<string, string> = {
  pending: "处理中",
  confirmed: "已到账",
  void: "已作废",
  unverified: "未核实",
  partial: "部分核实",
  verified: "已核实",
  bank: "银行转账",
  broker: "券商入金",
  exchange: "换汇",
  withdrawal: "移出台账",
};
type Modal =
  | "account"
  | "batch"
  | "transfer"
  | "goal"
  | "verify"
  | "confirm"
  | "void"
  | "correct"
  | "allocate";
type Form = Record<string, string>;

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    cache: "no-store",
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败，请稍后重试");
  return data;
}

async function allChanges(): Promise<Change[]> {
  const result: Change[] = [];
  let after = 0;
  for (;;) {
    const page = await api<Change[]>(`/changes?after=${after}`);
    result.push(...page);
    if (page.length < 1000) return result;
    after = page[page.length - 1].sequence;
  }
}
function dateValue(value: string) {
  if (!value || /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export default function FundingClient() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [form, setForm] = useState<Form>({});
  const [allocations, setAllocations] = useState<
    { batchId: string; amount: string }[]
  >([]);
  const [filter, setFilter] = useState("");
  const [idempotency, setIdempotency] = useState("");
  const load = useCallback(async () => {
    const [a, b, t, g, s, c] = await Promise.all([
      api<Account[]>("/accounts"),
      api<Batch[]>("/batches"),
      api<Transfer[]>("/transfers"),
      api<Goal[]>("/goals"),
      api<Summary>("/summary"),
      allChanges(),
    ]);
    setAccounts(a);
    setBatches(b);
    setTransfers(t);
    setGoals(g);
    setSummary(s);
    setChanges(c);
  }, []);
  useEffect(() => {
    load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [load]);
  const accountName = (id: string | null) =>
    accounts.find((a) => a.id === id)?.name || "未关联账户";
  const field = (key: string, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setIdempotency(requestKey());
  };
  function open(kind: Modal, values: Form = {}, source?: Transfer) {
    const existing = values.id
      ? [...accounts, ...batches, ...transfers, ...goals].find(
          (item) => item.id === values.id,
        )
      : undefined;
    setForm({
      expectedUpdatedAt: existing?.updatedAt || "",
      currency: "HKD",
      receivedCurrency: "HKD",
      amount: "",
      receivedAmount: "",
      feeAmount: "0",
      occurredAt: today(),
      confirmedAt: today(),
      status: "confirmed",
      kind: "broker",
      sourceStatus: "unverified",
      ...values,
    });
    setAllocations(
      source
        ? source.allocations.map((a) => ({ ...a, amount: decimal(a.amount) }))
        : [],
    );
    setModal(kind);
    setError("");
    setNotice("");
    setIdempotency(requestKey());
  }
  function changeAllocations(next: typeof allocations) {
    setAllocations(next);
    setIdempotency(requestKey());
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let endpoint = "";
      let method = "POST";
      let payload: Record<string, unknown> = {};
      if (modal === "account") {
        endpoint = form.id ? `/accounts/${form.id}` : "/accounts";
        method = form.id ? "PATCH" : "POST";
        payload = {
          name: form.name,
          kind: form.kind,
          institution: form.institution || "",
          note: form.note || "",
        };
      }
      if (modal === "batch") {
        endpoint = "/batches";
        payload = {
          accountId: form.accountId,
          name: form.name,
          currency: form.currency,
          amount: minor(form.amount),
          occurredAt: form.occurredAt,
          sourceStatus: form.sourceStatus,
          sourceNote: form.sourceNote || "",
          note: form.note || "",
        };
      }
      if (modal === "transfer" || modal === "correct") {
        endpoint =
          modal === "correct" ? `/transfers/${form.id}/correct` : "/transfers";
        payload = {
          kind: form.kind,
          fromAccountId: form.fromAccountId || null,
          toAccountId:
            form.kind === "withdrawal" ? null : form.toAccountId || null,
          currency: form.currency,
          amount: minor(form.amount),
          receivedCurrency: form.receivedCurrency,
          receivedAmount: minor(form.receivedAmount || form.amount),
          feeAmount: minor(form.feeAmount || "0"),
          allocations: allocations
            .filter((a) => a.batchId)
            .map((a) => ({ batchId: a.batchId, amount: minor(a.amount) })),
          historical: form.historical === "true",
          status: form.status,
          occurredAt: form.occurredAt,
          confirmedAt: form.status === "confirmed" ? form.confirmedAt : null,
          note: form.note || "",
        };
      }
      if (modal === "goal") {
        endpoint = form.id ? `/goals/${form.id}` : "/goals";
        method = form.id ? "PATCH" : "POST";
        payload = {
          name: form.name,
          accountId: form.accountId || null,
          currency: form.currency,
          amount: minor(form.amount),
          floorAmount: minor(form.floorAmount || "0"),
          startDate: form.startDate || null,
          endDate: form.endDate || null,
          note: form.note || "",
        };
      }
      if (modal === "verify") {
        endpoint = `/${form.entity}/${form.id}/verify`;
        payload = {
          sourceStatus: form.sourceStatus,
          sourceNote: form.sourceNote || "",
          pathStatus: form.sourceStatus,
          pathNote: form.sourceNote || "",
          note: form.sourceNote || "",
        };
      }
      if (modal === "confirm") {
        endpoint = `/transfers/${form.id}/confirm`;
        payload = {
          confirmedAt: form.confirmedAt,
          receivedAmount: minor(form.receivedAmount),
          note: form.note || "",
        };
      }
      if (modal === "void") {
        endpoint = `/${form.entity}/${form.id}/void`;
        payload = { note: form.note || "" };
      }
      if (modal === "allocate") {
        endpoint = `/transfers/${form.id}/allocations`;
        method = "POST";
        payload = {
          fromAccountId: form.fromAccountId || null,
          allocations: allocations
            .filter((a) => a.batchId)
            .map((a) => ({ batchId: a.batchId, amount: minor(a.amount) })),
        };
      }
      if (form.expectedUpdatedAt)
        payload.expectedUpdatedAt = form.expectedUpdatedAt;
      await api(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotency,
          "X-Funding-Source": "web",
        },
        body: JSON.stringify(payload),
      });
      setModal(null);
      setNotice("已保存，金额与进度已更新。");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  function exportCsv() {
    const rows = [
      [
        "日期",
        "类型",
        "转出",
        "转入",
        "转出币种",
        "转出金额",
        "收到币种",
        "收到金额",
        "状态",
        "备注",
      ],
      ...transfers.map((t) => [
        t.confirmedAt || t.occurredAt,
        statusText[t.kind],
        accountName(t.fromAccountId),
        accountName(t.toAccountId),
        t.currency,
        decimal(t.amount),
        t.receivedCurrency,
        decimal(t.receivedAmount),
        statusText[t.status],
        t.note,
      ]),
    ];
    const csv =
      "\ufeff" +
      rows
        .map((r) =>
          r
            .map(
              (v) =>
                `"${String(v)
                  .replace(/^[=+@-]/, "'$&")
                  .replaceAll('"', '""')}"`,
            )
            .join(","),
        )
        .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `券商入金-${today()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  const input = (
    key: string,
    label: string,
    type = "text",
    required = false,
  ) => (
    <label>
      {label}
      <input
        type={type}
        required={required}
        value={type === "date" ? dateValue(form[key] || "") : form[key] || ""}
        onChange={(e) => field(key, e.target.value)}
        step={type === "number" ? "0.01" : undefined}
        min={type === "number" ? "0" : undefined}
      />
    </label>
  );
  const accountSelect = (
    key: string,
    label: string,
    kind?: "bank" | "broker",
    required = false,
  ) => (
    <label>
      {label}
      <select
        required={required}
        value={form[key] || ""}
        onChange={(e) => field(key, e.target.value)}
      >
        <option value="">{required ? "请选择" : "不指定"}</option>
        {accounts
          .filter((a) => !a.archived && (!kind || a.kind === kind))
          .map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
      </select>
    </label>
  );
  const verificationFields = (
    <>
      <label>
        核实状态
        <select
          value={form.sourceStatus}
          onChange={(e) => field("sourceStatus", e.target.value)}
        >
          <option value="unverified">未核实</option>
          <option value="partial">部分核实</option>
          <option value="verified">已核实</option>
        </select>
      </label>
      <label className="wide">
        待核实事项 / 核实说明
        <textarea
          value={form.sourceNote || ""}
          onChange={(e) => field("sourceNote", e.target.value)}
        />
      </label>
    </>
  );
  const allocationFields = (
    <div className="wide">
      <h3>关联银行资金</h3>
      <p className="fund-muted">
        分配金额以转出币种计。可合并多笔资金；手续费另外占用转出资金。
      </p>
      {allocations.map((a, i) => (
        <div className="fund-actions" key={i} style={{ marginBottom: 8 }}>
          <select
            aria-label="来源资金"
            className="fund-filter"
            value={a.batchId}
            onChange={(e) =>
              changeAllocations(
                allocations.map((v, j) =>
                  j === i ? { ...v, batchId: e.target.value } : v,
                ),
              )
            }
          >
            <option value="">选择资金</option>
            {batches
              .filter(
                (b) =>
                  !b.voided &&
                  (!form.fromAccountId || b.accountId === form.fromAccountId) &&
                  b.currency === form.currency,
              )
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {accountName(b.accountId)} · {b.name} · 可用{" "}
                  {display(b.availableAmount)} {b.currency}
                </option>
              ))}
          </select>
          <input
            style={{ width: 130 }}
            aria-label="分配金额"
            placeholder="分配金额"
            required
            type="number"
            min="0.01"
            step="0.01"
            value={a.amount}
            onChange={(e) =>
              changeAllocations(
                allocations.map((v, j) =>
                  j === i ? { ...v, amount: e.target.value } : v,
                ),
              )
            }
          />
          <button
            type="button"
            onClick={() =>
              changeAllocations(allocations.filter((_, j) => j !== i))
            }
          >
            移除
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          changeAllocations([...allocations, { batchId: "", amount: "" }])
        }
      >
        ＋ 添加来源
      </button>
    </div>
  );
  const visibleTransfers = transfers.filter(
    (t) =>
      !filter ||
      t.currency === filter ||
      t.receivedCurrency === filter ||
      t.status === filter ||
      t.toAccountId === filter,
  );
  const pendingBatches = batches.filter(
    (b) => !b.voided && b.sourceStatus !== "verified",
  );

  return (
    <>
      <div className="fund-head">
        <div>
          <h1>券商入金</h1>
          <p className="fund-muted">
            记录资金去向，核实每一笔来源。只统计券商实际到账，币种分别计算。
          </p>
        </div>
        <div className="fund-actions">
          <button onClick={() => open("batch")}>登记银行资金</button>
          <button className="primary" onClick={() => open("transfer")}>
            ＋ 登记入金 / 转账
          </button>
        </div>
      </div>
      <nav className="fund-tabs" aria-label="台账页面">
        {[
          ["overview", "总览"],
          ["transfers", "入金与转账"],
          ["funds", "银行资金"],
          ["settings", "目标与账户"],
          ["changes", "修改记录"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && !modal && (
        <div className="fund-error" role="alert">
          {error}
          <button
            onClick={() => {
              setError("");
              load().catch((e) => setError(e.message));
            }}
          >
            重新加载
          </button>
        </div>
      )}
      {notice && (
        <div className="fund-success" role="status">
          {notice}
        </div>
      )}
      {loading ? (
        <p className="fund-empty">正在读取台账…</p>
      ) : (
        <>
          {tab === "overview" && (
            <>
              <div className="fund-grid">
                {summary?.currencies.map((s) => (
                  <section className="fund-card" key={s.currency}>
                    <h2>{s.currency} 累计入金</h2>
                    <div className="fund-number">
                      {display(s.brokerConfirmed)}
                    </div>
                    <div className="fund-stats">
                      <div className="fund-muted">
                        银行待入金<strong>{display(s.bankAvailable)}</strong>
                      </div>
                      <div className="fund-muted">
                        处理中<strong>{display(s.inTransit)}</strong>
                      </div>
                    </div>
                  </section>
                ))}
              </div>
              {!summary?.currencies.length && (
                <section className="fund-card fund-empty">
                  还没有资金记录。先在「目标与账户」添加银行和券商，再登记银行资金或补录历史入金。
                </section>
              )}
              <section className="fund-card">
                <div className="fund-head">
                  <h2>目标进度</h2>
                  <button onClick={() => open("goal")}>添加目标</button>
                </div>
                <div className="fund-grid">
                  {goals.map((g) => {
                    const extra = g as Goal & {
                      floorAmount?: string;
                      startDate?: string | null;
                      endDate?: string | null;
                    };
                    const total = BigInt(
                      summary?.goals.find((p) => p.id === g.id)?.actualAmount ||
                        "0",
                    );
                    const target = BigInt(g.amount);
                    const percent =
                      target > 0n ? Number((total * 10000n) / target) / 100 : 0;
                    const floor = BigInt(extra.floorAmount || "0");
                    return (
                      <div key={g.id}>
                        <h3>
                          {g.name} · {g.currency}
                        </h3>
                        <div>
                          {display(total.toString())} / {display(g.amount)}{" "}
                          <strong>（{percent}%）</strong>
                        </div>
                        <progress
                          max={100}
                          value={Math.min(percent, 100)}
                          aria-label={`${g.name}完成率`}
                        />
                        <p className="fund-muted">
                          {g.accountId ? accountName(g.accountId) : "全部券商"}{" "}
                          · {extra.startDate || "不限起始"} —{" "}
                          {extra.endDate || "不限结束"}
                          <br />
                          底线 {display(floor.toString())} ·{" "}
                          {total >= floor
                            ? "已达底线"
                            : `还差 ${display((floor - total).toString())}`}
                          <br />
                          距离目标还差{" "}
                          {display(
                            (target > total ? target - total : 0n).toString(),
                          )}
                        </p>
                      </div>
                    );
                  })}
                </div>
                {!goals.length && (
                  <p className="fund-muted">
                    尚未设置目标。可以分别设置 HKD / CNY 的目标与底线。
                  </p>
                )}
              </section>
              <section className="fund-card">
                <h2>来源核实待办 · {pendingBatches.length}</h2>
                {pendingBatches.map((b) => (
                  <div
                    className="fund-head"
                    key={b.id}
                    style={{ marginBottom: 12 }}
                  >
                    <div>
                      <strong>{b.name}</strong> · {display(b.amount)}{" "}
                      {b.currency}
                      <div className="fund-muted">
                        {accountName(b.accountId)} ·{" "}
                        {b.sourceNote || "尚未补充来源说明"}
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        open("verify", {
                          id: b.id,
                          entity: "batches",
                          sourceStatus: b.sourceStatus,
                          sourceNote: b.sourceNote,
                        })
                      }
                    >
                      核实来源
                    </button>
                  </div>
                ))}
                {!pendingBatches.length && (
                  <p className="fund-muted">暂无银行资金来源待办。</p>
                )}
                <h3>路径与历史入金待核实</h3>
                {transfers
                  .filter(
                    (t) =>
                      t.status !== "void" &&
                      ((t as Transfer & { pathStatus?: string }).pathStatus !==
                        "verified" ||
                        (t.historical && !t.allocations.length)),
                  )
                  .map((t) => (
                    <div
                      className="fund-head"
                      key={t.id}
                      style={{ marginBottom: 12 }}
                    >
                      <div>
                        {t.occurredAt} · {accountName(t.toAccountId)} ·{" "}
                        {display(t.receivedAmount)} {t.receivedCurrency}
                        <div className="fund-muted">
                          {t.historical && !t.allocations.length
                            ? "历史入金尚未关联来源"
                            : "转账路径待核实"}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setTab("transfers");
                          setFilter("");
                        }}
                      >
                        查看流水
                      </button>
                    </div>
                  ))}
              </section>
            </>
          )}
          {tab === "transfers" && (
            <section className="fund-card">
              <div className="fund-head">
                <h2>入金与转账</h2>
                <div className="fund-actions">
                  <select
                    className="fund-filter"
                    aria-label="筛选流水"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="">全部流水</option>
                    <option>HKD</option>
                    <option>CNY</option>
                    <option value="pending">处理中</option>
                    <option value="confirmed">已到账</option>
                    <option value="void">已作废</option>
                    {accounts
                      .filter((a) => a.kind === "broker")
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                  <button onClick={exportCsv}>导出 CSV</button>
                </div>
              </div>
              <div className="fund-table">
                <table>
                  <thead>
                    <tr>
                      <th>日期 / 类型</th>
                      <th>资金路径</th>
                      <th>金额</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTransfers.map((t) => (
                      <tr key={t.id}>
                        <td>
                          {t.confirmedAt || t.occurredAt}
                          <small>{statusText[t.kind]}</small>
                        </td>
                        <td>
                          {accountName(t.fromAccountId)} →{" "}
                          {t.kind === "withdrawal"
                            ? "台账外"
                            : accountName(t.toAccountId)}
                          <small>{t.note}</small>
                          <details>
                            <summary>来源与详情</summary>
                            <small>
                              记录 ID：{t.id}
                              <br />
                              手续费：{display(t.feeAmount)} {t.currency}
                              <br />
                              {t.allocations
                                .map(
                                  (a) =>
                                    `${batches.find((b) => b.id === a.batchId)?.name || a.batchId}：${display(a.amount)} ${t.currency}`,
                                )
                                .join("；") || "尚未关联来源"}
                            </small>
                          </details>
                        </td>
                        <td>
                          {display(t.receivedAmount)} {t.receivedCurrency}
                          <small>
                            转出 {display(t.amount)} {t.currency}
                          </small>
                        </td>
                        <td>
                          <span className="fund-badge">
                            {statusText[t.status]}
                          </span>
                          <small>
                            {
                              statusText[
                                (t as Transfer & { pathStatus?: string })
                                  .pathStatus || "unverified"
                              ]
                            }
                          </small>
                        </td>
                        <td>
                          {t.status !== "void" && (
                            <div className="fund-actions">
                              {t.status === "pending" && (
                                <button
                                  onClick={() =>
                                    open("confirm", {
                                      id: t.id,
                                      receivedAmount: decimal(t.receivedAmount),
                                      note: t.note,
                                    })
                                  }
                                >
                                  确认到账
                                </button>
                              )}
                              <button
                                onClick={() =>
                                  open("verify", {
                                    id: t.id,
                                    entity: "transfers",
                                    sourceStatus:
                                      (t as Transfer & { pathStatus?: string })
                                        .pathStatus || "unverified",
                                    sourceNote:
                                      (t as Transfer & { pathNote?: string })
                                        .pathNote || "",
                                  })
                                }
                              >
                                核实路径
                              </button>
                              {t.historical && (
                                <button
                                  onClick={() =>
                                    open(
                                      "allocate",
                                      {
                                        id: t.id,
                                        currency: t.currency,
                                        fromAccountId: t.fromAccountId || "",
                                      },
                                      t,
                                    )
                                  }
                                >
                                  补充来源
                                </button>
                              )}
                              <button
                                onClick={() =>
                                  open(
                                    "correct",
                                    {
                                      id: t.id,
                                      kind: t.kind,
                                      fromAccountId: t.fromAccountId || "",
                                      toAccountId: t.toAccountId || "",
                                      currency: t.currency,
                                      receivedCurrency: t.receivedCurrency,
                                      amount: decimal(t.amount),
                                      receivedAmount: decimal(t.receivedAmount),
                                      feeAmount: decimal(t.feeAmount),
                                      status: t.status,
                                      occurredAt: t.occurredAt,
                                      confirmedAt: t.confirmedAt || today(),
                                      historical: String(t.historical),
                                      note: t.note,
                                    },
                                    t,
                                  )
                                }
                              >
                                更正
                              </button>
                              <button
                                onClick={() =>
                                  open("void", {
                                    id: t.id,
                                    entity: "transfers",
                                  })
                                }
                              >
                                作废
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!visibleTransfers.length && (
                <p className="fund-empty">暂无符合条件的流水。</p>
              )}
            </section>
          )}
          {tab === "funds" && (
            <section className="fund-card">
              <h2>银行资金</h2>
              <p className="fund-muted">
                仅包含登记用于入金的资金，不代表银行完整余额。银行转账到账后会自动生成目的银行资金。
              </p>
              <div className="fund-table">
                <table>
                  <thead>
                    <tr>
                      <th>资金 / 银行</th>
                      <th>登记金额</th>
                      <th>剩余可用</th>
                      <th>来源核实</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b.id}>
                        <td>
                          {b.name}
                          <small>
                            {accountName(b.accountId)} · {b.occurredAt}
                            <br />
                            {b.note}
                          </small>
                          <details>
                            <summary>资金路径</summary>
                            {transfers
                              .filter(
                                (t) =>
                                  t.resultBatchId === b.id ||
                                  t.allocations.some((a) => a.batchId === b.id),
                              )
                              .map((t) => (
                                <small key={t.id}>
                                  {t.occurredAt} {accountName(t.fromAccountId)}{" "}
                                  → {accountName(t.toAccountId)} ·{" "}
                                  {display(t.receivedAmount)}{" "}
                                  {t.receivedCurrency} · {statusText[t.status]}
                                </small>
                              ))}
                          </details>
                        </td>
                        <td>
                          {display(b.amount)} {b.currency}
                        </td>
                        <td>
                          {b.voided
                            ? "已作废"
                            : `${display(b.availableAmount)} ${b.currency}`}
                        </td>
                        <td>
                          {statusText[b.sourceStatus]}
                          <small>{b.sourceNote}</small>
                        </td>
                        <td>
                          {!b.voided && (
                            <div className="fund-actions">
                              <button
                                onClick={() => {
                                  open("transfer", {
                                    fromAccountId: b.accountId,
                                    currency: b.currency,
                                    receivedCurrency: b.currency,
                                    amount: decimal(b.availableAmount),
                                  });
                                  setAllocations([
                                    {
                                      batchId: b.id,
                                      amount: decimal(b.availableAmount),
                                    },
                                  ]);
                                }}
                                disabled={b.availableAmount === "0"}
                              >
                                登记入金
                              </button>
                              <button
                                onClick={() =>
                                  open("verify", {
                                    id: b.id,
                                    entity: "batches",
                                    sourceStatus: b.sourceStatus,
                                    sourceNote: b.sourceNote,
                                  })
                                }
                              >
                                核实
                              </button>
                              <button
                                onClick={() =>
                                  open("void", { id: b.id, entity: "batches" })
                                }
                              >
                                作废
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!batches.length && (
                <p className="fund-empty">尚未登记银行资金。</p>
              )}
            </section>
          )}
          {tab === "settings" && (
            <>
              <section className="fund-card">
                <div className="fund-head">
                  <h2>银行与券商</h2>
                  <button onClick={() => open("account", { kind: "bank" })}>
                    添加账户
                  </button>
                </div>
                {accounts.map((a) => (
                  <p key={a.id}>
                    <strong>{a.name}</strong> ·{" "}
                    {a.kind === "bank" ? "银行" : "券商"}{" "}
                    <span className="fund-muted">
                      {a.institution} {a.note}
                    </span>{" "}
                    <button
                      onClick={() =>
                        open("account", {
                          id: a.id,
                          name: a.name,
                          kind: a.kind,
                          institution: a.institution,
                          note: a.note,
                        })
                      }
                    >
                      编辑
                    </button>
                  </p>
                ))}
                {!accounts.length && (
                  <p className="fund-empty">先添加常用银行和券商。</p>
                )}
              </section>
              <section className="fund-card">
                <div className="fund-head">
                  <h2>入金目标</h2>
                  <button onClick={() => open("goal")}>添加目标</button>
                </div>
                {goals.map((g) => {
                  const x = g as Goal & {
                    floorAmount?: string;
                    startDate?: string | null;
                    endDate?: string | null;
                  };
                  return (
                    <div
                      className="fund-head"
                      key={g.id}
                      style={{ marginTop: 12 }}
                    >
                      <div>
                        {g.name} · {display(g.amount)} {g.currency}
                        <small className="fund-muted">
                          {" "}
                          ·{" "}
                          {g.accountId ? accountName(g.accountId) : "全部券商"}
                        </small>
                      </div>
                      <button
                        onClick={() =>
                          open("goal", {
                            id: g.id,
                            name: g.name,
                            accountId: g.accountId || "",
                            currency: g.currency,
                            amount: decimal(g.amount),
                            floorAmount: decimal(x.floorAmount || "0"),
                            startDate: x.startDate || "",
                            endDate: x.endDate || "",
                            note: g.note,
                          })
                        }
                      >
                        编辑
                      </button>
                    </div>
                  );
                })}
              </section>
              <p className="fund-muted">
                助手接口：
                <a
                  href={`${API}/openapi.json`}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看 API 说明 ↗
                </a>{" "}
                · 金额按最小货币单位传输，网页按元展示。
              </p>
            </>
          )}
          {tab === "changes" && (
            <section className="fund-card">
              <h2>修改记录</h2>
              <p className="fund-muted">
                保存操作与数据快照，作废不会删除历史记录。
              </p>
              {[...changes].reverse().map((c) => (
                <details key={c.sequence}>
                  <summary>
                    {c.at} · {c.entity} · {c.action} · {c.source}
                  </summary>
                  <pre className="fund-detail">
                    {JSON.stringify(
                      { before: c.before, after: c.data },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              ))}
              {!changes.length && <p className="fund-empty">暂无修改记录。</p>}
            </section>
          )}
        </>
      )}
      {modal && (
        <div className="fund-overlay">
          <section
            className="fund-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fund-dialog-title"
          >
            <h2 id="fund-dialog-title">
              {
                {
                  account: "添加银行 / 券商",
                  batch: "登记银行资金",
                  transfer: "登记入金 / 转账",
                  goal: "设置入金目标",
                  verify: "核实信息",
                  confirm: "确认实际到账",
                  void: "作废记录",
                  correct: "更正流水",
                  allocate: "补充历史入金来源",
                }[modal]
              }
            </h2>
            {error && (
              <div className="fund-error" role="alert">
                {error}
              </div>
            )}
            <form className="fund-form" onSubmit={submit}>
              {modal === "account" && (
                <>
                  {input("name", "账户名称", "text", true)}
                  <label>
                    账户类型
                    <select
                      disabled={!!form.id}
                      value={form.kind}
                      onChange={(e) => field("kind", e.target.value)}
                    >
                      <option value="bank">银行</option>
                      <option value="broker">券商</option>
                    </select>
                  </label>
                  {input("institution", "机构 / 所在地区")}
                </>
              )}
              {modal === "batch" && (
                <>
                  {input("name", "资金名称", "text", true)}
                  {accountSelect("accountId", "所在银行", "bank", true)}
                  {input("currency", "币种（如 HKD、CNY）", "text", true)}
                  {input("amount", "登记金额", "number", true)}
                  {input("occurredAt", "银行到账日期", "date", true)}
                  {verificationFields}
                </>
              )}
              {(modal === "transfer" || modal === "correct") && (
                <>
                  <label>
                    流转类型
                    <select
                      value={form.kind}
                      onChange={(e) => field("kind", e.target.value)}
                    >
                      <option value="broker">券商入金</option>
                      <option value="bank">银行间转账</option>
                      <option value="exchange">换汇</option>
                      <option value="withdrawal">移出台账</option>
                    </select>
                  </label>
                  <label>
                    到账状态
                    <select
                      value={form.status}
                      onChange={(e) => field("status", e.target.value)}
                    >
                      <option value="confirmed">已到账</option>
                      <option value="pending">处理中</option>
                    </select>
                  </label>
                  {accountSelect(
                    "fromAccountId",
                    "转出银行",
                    "bank",
                    form.historical !== "true",
                  )}
                  {form.kind !== "withdrawal" &&
                    accountSelect(
                      "toAccountId",
                      "收款账户",
                      form.kind === "broker" ? "broker" : "bank",
                      true,
                    )}
                  {input("currency", "转出币种", "text", true)}
                  {input("amount", "转出本金", "number", true)}
                  {input("receivedCurrency", "收到币种", "text", true)}
                  {input(
                    "receivedAmount",
                    "实际 / 预计收到金额（默认等于本金）",
                    "number",
                  )}
                  {input("feeAmount", "另付手续费（转出币种）", "number")}
                  {input("occurredAt", "发起日期", "date", true)}
                  {form.status === "confirmed" &&
                    input("confirmedAt", "到账日期", "date", true)}
                  {form.kind === "broker" && (
                    <label>
                      历史补录
                      <select
                        value={form.historical || "false"}
                        onChange={(e) => field("historical", e.target.value)}
                      >
                        <option value="false">关联银行资金</option>
                        <option value="true">历史入金，允许来源暂缺</option>
                      </select>
                    </label>
                  )}
                  {allocationFields}
                  {modal === "correct" && (
                    <p className="wide fund-muted">
                      更正将保留旧记录并生成替代流水；存在已使用的下游资金时需先处理下游。
                    </p>
                  )}
                </>
              )}
              {modal === "goal" && (
                <>
                  {input("name", "目标名称", "text", true)}
                  {accountSelect(
                    "accountId",
                    "券商范围（不指定即全部）",
                    "broker",
                  )}
                  {input("currency", "币种", "text", true)}
                  {input("amount", "目标金额", "number", true)}
                  {input("floorAmount", "底线金额", "number")}
                  {input("startDate", "起始日期（可选）", "date")}
                  {input("endDate", "结束日期（可选）", "date")}
                </>
              )}
              {modal === "verify" && verificationFields}
              {modal === "confirm" && (
                <>
                  {input("confirmedAt", "实际到账日期", "date", true)}
                  {input("receivedAmount", "实际到账金额", "number", true)}
                </>
              )}
              {modal === "allocate" && (
                <>
                  {accountSelect("fromAccountId", "转出银行", "bank", true)}
                  {allocationFields}
                </>
              )}
              {modal === "void" && (
                <p className="wide">
                  作废后将撤销该记录对金额和进度的影响，原记录仍保留。已经被后续转账使用的资金不能直接作废。
                </p>
              )}
              {modal !== "verify" && modal !== "allocate" && (
                <label className="wide">
                  {modal === "void" ? "作废原因" : "备注"}
                  <textarea
                    required={modal === "void"}
                    value={form.note || ""}
                    onChange={(e) => field("note", e.target.value)}
                  />
                </label>
              )}
              <footer>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setModal(null);
                    setError("");
                  }}
                >
                  取消
                </button>
                <button className="primary" disabled={busy} type="submit">
                  {busy ? "保存中…" : "保存"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
