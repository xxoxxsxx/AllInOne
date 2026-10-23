import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getDB, getRun } from "@/modules/stocks/store";
import { displayClock } from "@/modules/stocks/tz";
import { timezoneValue } from "@/modules/stocks/windows";
import { money, statusText } from "../../display";

export const dynamic = "force-dynamic";

// 原版 web.go runPage：Title 为「查询 #ID」。
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `查询 #${id} · TickerSentry` };
}

// DOM 结构对应 templates/run.html。
//
// 进行中轮询说明：本页选择 meta refresh 方案（二选一中更简单者）——run 处于 running
// 状态时输出 <meta http-equiv="refresh" content="2">，整页每 2 秒刷新，结束后停止；
// 与原版 app.js 的 fetch 轮询展示同一份数据（状态、reason、done/total、逐股结果），
// 只是实现更简单，无客户端依赖。
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericID = Number(id);
  if (!Number.isInteger(numericID) || numericID <= 0) notFound();
  const db = getDB();
  const run = getRun(db, numericID);
  if (!run) notFound();
  const tz = timezoneValue(db);

  return (
    <div>
      {run.status === "running" ? <meta httpEquiv="refresh" content="2" /> : null}
      <div className="page-head">
        <div>
          <Link className="back-link" href="/stocks">
            ← 返回监控概览
          </Link>
          <span className="eyebrow">QUERY DETAIL</span>
          <h1>
            {run.kind === "manual" ? "手动查询" : "自动查询"} #{run.id}
          </h1>
          <p>查看每只股票的报价时间、来源、结果和提醒状态。</p>
        </div>
        <span className="status-pill" id="status">
          {statusText(run.status)}
        </span>
      </div>
      <section className="card run-summary">
        <div>
          <span className="eyebrow">STARTED AT</span>
          <strong>{displayClock(new Date(run.started_at), tz)}</strong>
        </div>
        {run.slot_at ? (
          <div>
            <span className="eyebrow">SCHEDULED FOR</span>
            <strong>{displayClock(new Date(run.slot_at), tz)}</strong>
          </div>
        ) : null}
        <div>
          <span className="eyebrow">TIMEZONE</span>
          <strong>{tz}</strong>
        </div>
      </section>
      {run.reason ? (
        <p className="info-strip" id="reason">
          {run.reason}
        </p>
      ) : (
        <p id="reason" aria-live="polite" />
      )}
      <p id="poll-message" className="muted small" role="status"></p>

      <section className="card">
        <div className="panel-head">
          <div>
            <span className="eyebrow">RESULTS</span>
            <h2>
              逐股结果{" "}
              <span id="run-progress" className="status-pill">
                {run.done} / {run.total}
              </span>
            </h2>
            <p>时间按 {tz} 显示。延迟未知不代表实时。</p>
          </div>
        </div>
        {run.results.length > 0 ? (
          <div className="scroll">
            <table id="results" data-run-id={run.id} data-timezone={tz} data-status={run.status}>
              <thead>
                <tr>
                  <th>代码</th>
                  <th>价格 USD</th>
                  <th>今开 USD</th>
                  <th>昨收 USD</th>
                  <th>行情时间</th>
                  <th>查询时间</th>
                  <th>来源</th>
                  <th>时间字段</th>
                  <th>延迟</th>
                  <th>状态 / 错误</th>
                  <th>提醒</th>
                </tr>
              </thead>
              <tbody>
                {run.results.map((r) => (
                  <tr key={r.Symbol}>
                    <td data-label="代码">
                      <strong>{r.Symbol}</strong>
                    </td>
                    <td data-label="价格 USD">{r.Price ? money(r.Price) : "—"}</td>
                    <td data-label="今开 USD">{r.Open ? money(r.Open) : "—"}</td>
                    <td data-label="昨收 USD">{r.PrevClose ? money(r.PrevClose) : "—"}</td>
                    <td data-label="行情时间">{displayClock(r.QuoteAt ? new Date(r.QuoteAt) : null, tz)}</td>
                    <td data-label="查询时间">{displayClock(r.FetchedAt ? new Date(r.FetchedAt) : null, tz)}</td>
                    <td data-label="来源">{r.Source}</td>
                    <td data-label="时间字段">{r.TimeField}</td>
                    <td data-label="延迟">{r.Delay}</td>
                    <td data-label="状态">
                      {statusText(r.Status)} {r.Error}
                    </td>
                    <td data-label="提醒">{r.AlertStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">本次没有逐股结果，请查看上方任务状态与原因。</p>
        )}
      </section>
      <p className="run-footnote">
        自动与手动查询都会检查报价时间、交易时段及档位；有效报价命中时发送到所有启用渠道。<code>last_quote_at</code> 和{" "}
        <code>last_update_at</code> 均可用于时间检查。
      </p>
    </div>
  );
}
