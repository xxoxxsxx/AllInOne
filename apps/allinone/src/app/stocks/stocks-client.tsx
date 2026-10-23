"use client";

// 原版 static/app.js 的行为移植（data-confirm、立即查询、添加股票弹窗、
// 导航高亮、toast）。逐条对应：
// - form[data-confirm] 与 #stock-form 的提交确认 → StocksBehaviors（document 捕获阶段委托，
//   preventDefault + stopPropagation 保证 Server Action 不触发，语义与 app.js 相同）；
// - #run 立即查询 → RunNowButton，改为直接调用现有 Server Action startRunAction
//   （成功后该 Action redirect 到 /stocks/runs/{id}，与原版 location.assign 一致）；
// - #stock-dialog 添加股票 → StockDialog，调用新增的 stockAddOnceAction（不重定向版本），
//   「保存并继续添加」留在弹窗内 + toast，「保存并设置提醒」跳转详情页，与原版一致；
// - 导航高亮 → StocksNav（usePathname，SSR 即输出 aria-current，等价于 app.js 的
//   aria-current 逻辑，路径映射为 /stocks 段）；
// - 首页搜索/监控状态过滤 → WatchFilter（#stock-search / #stock-filter，逐条移植）；
// - toast → 与 app.js 相同的 .toast-stack/.toast 命令式实现（沿用原版 class 与视觉）；
// - data-flash 提示条 → Flash 组件（水合后转为 toast 并隐藏自身，等价于原版
//   el.remove()，这里用 hidden 属性代替移除以保持 React DOM 一致）。
// run 页进行中轮询选择 meta refresh 方案（见 runs/[id]/page.tsx 注释），无需客户端 JS。

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { FormEvent, SyntheticEvent } from "react";

import { startRunAction, stockAddOnceAction } from "./actions";

// —— toast（原版 app.js 的实现） ——
let toastStack: HTMLDivElement | null = null;

function toast(text: string): void {
  if (!text) return;
  if (!toastStack) {
    toastStack = document.createElement("div");
    toastStack.className = "toast-stack";
    toastStack.setAttribute("role", "status");
    toastStack.setAttribute("aria-live", "polite");
  }
  // A native <dialog> renders in the top layer, so host toasts inside it while open.
  const host = document.querySelector("dialog[open]") ?? document.body;
  if (toastStack.parentElement !== host) host.appendChild(toastStack);
  const item = document.createElement("div");
  item.className = "toast";
  const label = document.createElement("span");
  label.textContent = text;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "关闭提示");
  close.textContent = "×";
  item.append(label, close);
  toastStack.append(item);
  let timer = 0;
  const dismiss = () => {
    window.clearTimeout(timer);
    item.classList.add("is-leaving");
    item.addEventListener("transitionend", () => item.remove(), { once: true });
    window.setTimeout(() => item.remove(), 400);
  };
  close.addEventListener("click", dismiss);
  timer = window.setTimeout(dismiss, 5000);
}

// —— data-flash 提示条：水合后转为 toast 并隐藏（原版为移除节点） ——
export function Flash({ text }: { text: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!text) return;
    toast(text);
    setShown(true);
  }, [text]);
  if (!text) return null;
  return (
    <p className="info-strip" role="status" data-flash hidden={shown}>
      {text}
    </p>
  );
}

// —— 导航高亮（原版按路径前缀设置 aria-current="page"，映射到 /stocks 段） ——
export function StocksNav() {
  const pathname = usePathname();
  const section = pathname.startsWith("/stocks/settings")
    ? "/stocks/settings"
    : pathname.startsWith("/stocks/schedule")
      ? "/stocks/schedule"
      : "/stocks";
  return (
    <nav aria-label="主导航">
      <Link href="/">工具箱</Link>
      <Link href="/stocks" aria-current={section === "/stocks" ? "page" : undefined}>
        监控概览
      </Link>
      <Link href="/stocks/schedule" aria-current={section === "/stocks/schedule" ? "page" : undefined}>
        自动查询
      </Link>
      <Link href="/stocks/settings" aria-current={section === "/stocks/settings" ? "page" : undefined}>
        设置
      </Link>
    </nav>
  );
}

// —— 全局提交确认委托（data-confirm + #stock-form 改代码二次确认） ——
export function StocksBehaviors() {
  useEffect(() => {
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const confirmText = form.dataset.confirm;
      if (confirmText && !window.confirm(confirmText)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (form.id === "stock-form") {
        const field = form.elements.namedItem("symbol");
        const symbol = field instanceof HTMLInputElement ? field.value.trim().toUpperCase() : "";
        const original = form.dataset.originalSymbol ?? "";
        if (symbol !== original && !window.confirm("修改代码会重新启用全部档位提醒。继续？")) {
          event.preventDefault();
          event.stopPropagation();
        }
      }
    };
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);
  return null;
}

// —— 首页监控列表搜索/过滤（app.js #stock-search / #stock-filter 逐条移植） ——
export function WatchFilter() {
  useEffect(() => {
    const search = document.querySelector<HTMLInputElement>("#stock-search");
    const filter = document.querySelector<HTMLSelectElement>("#stock-filter");
    if (!search || !filter) return;
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".watch-item"));
    const count = document.querySelector<HTMLElement>("#stock-count");
    const empty = document.querySelector<HTMLElement>("#no-stock-match");
    const update = () => {
      const query = search.value.trim().toLocaleLowerCase();
      let visible = 0;
      for (const row of rows) {
        const matches = `${row.dataset.symbol ?? ""} ${row.dataset.note ?? ""}`.toLocaleLowerCase().includes(query);
        const capped = row.dataset.capped === "true";
        const status =
          filter.value === "all" ||
          (filter.value === "active" && row.dataset.enabled === "true" && !capped) ||
          (filter.value === "paused" && row.dataset.enabled === "false") ||
          (filter.value === "capped" && capped);
        row.hidden = !matches || !status;
        if (!row.hidden) visible++;
      }
      if (count) count.textContent = `显示 ${visible} / ${rows.length} 只`;
      if (empty) empty.hidden = visible !== 0;
    };
    search.addEventListener("input", update);
    filter.addEventListener("change", update);
    update();
    return () => {
      search.removeEventListener("input", update);
      filter.removeEventListener("change", update);
    };
  }, []);
  return null;
}

// —— 首页「立即查询」（原版 fetch /api/runs → location.assign；此处直接调用 Server Action，
//    Action 成功后 redirect 到 /stocks/runs/{id}，失败 redirect 到 ?error= 提示条） ——
export function RunNowButton() {
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <>
      <button
        id="run"
        type="button"
        disabled={pending}
        onClick={() => {
          setMessage("正在创建查询任务…");
          startTransition(async () => {
            try {
              await startRunAction();
            } catch {
              setMessage("查询未启动：请稍后重试。");
            }
          });
        }}
      >
        立即查询 <span aria-hidden="true">↗</span>
      </button>
      <p id="run-message" role="status" aria-live="polite">
        {message}
      </p>
    </>
  );
}

// —— 添加股票弹窗（common 里的 #stock-dialog，home/stock 两页共用） ——
export function StockDialog() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const changedRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-add-stock]"));
    const open = () => dialog.showModal();
    for (const button of buttons) button.addEventListener("click", open);
    return () => {
      for (const button of buttons) button.removeEventListener("click", open);
    };
  }, []);

  const requestClose = () => {
    if (!saving) dialogRef.current?.close();
  };

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (saving) event.preventDefault();
  };

  const handleClose = () => {
    if (changedRef.current) location.reload();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const form = formRef.current;
    if (!form) return;
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
    const next = submitter instanceof HTMLButtonElement ? submitter.value : "";
    setSaving(true);
    setMessage("正在保存…");
    const buttons = Array.from(form.querySelectorAll<HTMLButtonElement>("button"));
    for (const button of buttons) button.disabled = true;
    try {
      const result = await stockAddOnceAction(new FormData(form));
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      changedRef.current = true;
      if (next === "levels") {
        location.assign(`/stocks/${result.id}?flash=stock_added#add-level`);
        return;
      }
      form.reset();
      setMessage("");
      toast(`已添加 ${result.symbol}。可以继续添加下一只，关闭窗口后在列表设置提醒。`);
      const symbol = form.elements.namedItem("symbol");
      if (symbol instanceof HTMLInputElement) symbol.focus();
    } catch (error) {
      setMessage(
        error instanceof TypeError
          ? "连接中断，保存结果未知。请关闭窗口并刷新列表确认后再试。"
          : error instanceof Error
            ? error.message
            : "保存失败",
      );
    } finally {
      setSaving(false);
      for (const button of buttons) button.disabled = false;
    }
  };

  return (
    <dialog
      id="stock-dialog"
      aria-labelledby="stock-dialog-title"
      ref={dialogRef}
      onCancel={handleCancel}
      onClose={handleClose}
    >
      <div className="panel-head">
        <div>
          <h2 id="stock-dialog-title">添加股票</h2>
          <p>可以连续添加，也可以直接设置买入和卖出提醒。</p>
        </div>
        <button type="button" id="close-stock-dialog" aria-label="关闭添加窗口" onClick={requestClose}>
          关闭
        </button>
      </div>
      <form id="add-stock-form" ref={formRef} onSubmit={handleSubmit}>
        <label>
          股票代码
          <input name="symbol" placeholder="例如 AAPL" maxLength={15} required autoComplete="off" autoFocus />
        </label>
        <label>
          备注
          <input name="note" maxLength={200} placeholder="可选" />
        </label>
        <p id="add-stock-message" role="status" aria-live="polite">
          {message}
        </p>
        <div className="dialog-actions">
          <button className="primary" type="submit" name="next" value="continue">
            保存并继续添加
          </button>
          <button type="submit" name="next" value="levels">
            保存并设置提醒 →
          </button>
        </div>
      </form>
    </dialog>
  );
}
