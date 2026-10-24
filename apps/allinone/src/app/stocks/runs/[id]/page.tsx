import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getDB, getRun, getRunProgress, getQuotaStatus } from "@/modules/stocks/store";
import { displayClock } from "@/modules/stocks/tz";
import { timezoneValue } from "@/modules/stocks/windows";
import { money, statusText } from "../../display";
import { RunProgress } from "../../run-progress";

export const dynamic = "force-dynamic";

// 原版 web.go runPage：Title 为「查询 #ID」。
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `查询 #${id} · TickerSentry` };
}

// Preserve the original results table while refreshing batched progress in place.
export default async function RunPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ reused?: string }>;
}) {
  const sp = await searchParams;
  const { id } = await params;
  const numericID = Number(id);
  if (!Number.isInteger(numericID) || numericID <= 0) notFound();
  const db = getDB();
  const run = getRun(db, numericID);
  if (!run) notFound();
  const tz = timezoneValue(db);
  const progress = getRunProgress(db, numericID);
  const quota = getQuotaStatus(db);
  const active = run.status === "running";
  const waiting = active && progress.waitUntil > 0;

  return (
    <div>
      {sp.reused === "1" ? <p className="info-strip" role="status">已有查询任务正在执行，已打开当前任务；没有重复查询或额外消耗额度。</p> : null}
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
          {waiting ? "等待额度" : statusText(run.status)}
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
      {run.reason || waiting ? (
        <p className="info-strip" id="reason">
          {run.reason || "正在等待行情额度，恢复后将继续本轮剩余查询。"}
        </p>
      ) : (
        <p id="reason" aria-live="polite" />
      )}
      <RunProgress active={active} nextRequestAt={waiting ? new Date(progress.waitUntil).toISOString() : null} />
      <p className="muted small">过去 24 小时额度：{quota.dayUsed} / {quota.dayLimit}（本应用统计）；当前分钟剩余 {Math.max(0, quota.minuteLimit - quota.minuteUsed)} 次。</p>

      <section className="card">
        <div className="panel-head">
          <div>
            <span className="eyebrow">RESULTS</span>
            <h2>
              逐股结果{" "}
              <span id="run-progress" className="status-pill">
                {progress.completed} / {progress.total}
              </span>
            </h2>
            <p>时间按 {tz} 显示。延迟未知不代表实时。</p>
            <p className="run-counts small">
              <span>成功 {run.results.filter(r => r.Status === "ok").length}</span>
              <span>失败 {run.results.filter(r => r.Status === "error" || r.Status === "failed").length}</span>
              <span>跳过 {run.results.filter(r => r.Status === "skipped").length}</span>
              <span>待处理 {run.results.filter(r => ["pending", "waiting", "querying"].includes(r.Status)).length}</span>
            </p>
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
                      <span className="result-status" data-state={r.Status}>{statusText(r.Status)}</span>
                      {r.Error ? <div className="small">{r.Error}</div> : null}
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
