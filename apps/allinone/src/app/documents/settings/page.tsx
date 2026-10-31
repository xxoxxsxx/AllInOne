import Link from "next/link";
import type { CSSProperties } from "react";

import { todayStr } from "@/lib/documents/constants";
import { getDocumentsDB, listDocuments } from "@/lib/documents/db";
import { getReminderSettings, selectExpiringDocuments } from "@/lib/documents/reminders";

import { RemindersSettings } from "./reminders-settings";

export const dynamic = "force-dynamic";

export const metadata = { title: "到期提醒设置 · 证件夹" };

// /documents/settings 路由页：服务端读取提醒设置与 Bark 配置状态后挂载设置面板。
// Bark 的服务地址与设备 Key 复用行情（TickerSentry）设置，只在服务端读取；
// 页面仅展示「是否已配置 + 主机名」，绝不把 Key 下发给客户端。
// 面板本体在 ./reminders-settings.tsx，动作在 ../reminders-actions.ts。

const PREVIEW_LIMIT = 10;

const cardStyle: CSSProperties = {
  border: "1px solid var(--border, rgba(127,127,127,.35))",
  borderRadius: 12,
  padding: 16,
  margin: "16px 0 0",
  maxWidth: 560,
  display: "grid",
  gap: 8,
};

const cardTitleStyle: CSSProperties = { margin: 0, fontSize: 15 };

const cardTextStyle: CSSProperties = { margin: 0, fontSize: 13, color: "var(--text-2, #666)", lineHeight: 1.7 };

const warnStyle: CSSProperties = {
  margin: "12px 0 0",
  padding: "8px 10px",
  borderRadius: 8,
  fontSize: 13,
  background: "rgba(196,74,58,.12)",
  color: "#a03d31",
};

const previewListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  display: "grid",
  gap: 2,
  fontSize: 13,
  color: "var(--text-2, #666)",
};

async function barkStatus(): Promise<{ configured: boolean; host: string }> {
  // 行情库不可用 / 未配置 / URL 异常时一律按「未配置」展示，页面不因 stocks 缺失而渲染失败。
  try {
    const { getDB, barkSettings } = await import("@/modules/stocks/store");
    const target = barkSettings(getDB());
    const configured = target.URL.trim() !== "" && target.Key.trim() !== "";
    let host = "";
    if (configured) {
      try {
        host = new URL(target.URL.trim()).host;
      } catch {
        host = "";
      }
    }
    return { configured, host };
  } catch {
    return { configured: false, host: "" };
  }
}

export default async function ReminderSettingsPage() {
  const db = getDocumentsDB();
  const settings = getReminderSettings(db);
  const dueDocs = selectExpiringDocuments(listDocuments(db, todayStr()));
  const bark = await barkStatus();
  const schedulerDisabled = process.env.DISABLE_SCHEDULER === "1";
  const hourText = `${String(settings.hour).padStart(2, "0")}:00`;

  return (
    <main className="docs-page">
      <Link href="/documents" className="docs-back">← 证件夹</Link>
      <header className="docs-hero">
        <p className="docs-kicker">Document Vault</p>
        <h1 className="docs-title">到期提醒</h1>
        <p className="docs-sub">每天早上把 30 天内到期的证件合并成一条 Bark 推送，每天最多一次。</p>
      </header>

      {schedulerDisabled ? (
        <p style={warnStyle} role="status">
          内置调度器已禁用（DISABLE_SCHEDULER=1）：设置仍会保存，但提醒不会自动发送；如需自动推送请在部署环境移除该变量。
        </p>
      ) : null}

      <RemindersSettings initialSettings={settings} />

      <section style={cardStyle} aria-label="推送渠道说明">
        <h2 style={cardTitleStyle}>推送渠道：复用行情 Bark 配置</h2>
        <p style={cardTextStyle}>
          当前状态：{bark.configured ? `已配置（${bark.host || "Bark 服务"}）` : "未配置"}
        </p>
        <p style={cardTextStyle}>
          本功能不单独保存任何 Bark 地址或设备 Key：推送直接使用
          <Link href="/stocks/settings">「行情与通知设置（TickerSentry）」</Link>
          中已保存的 Bark 服务地址与设备 Key。设备 Key 只保存在服务端数据库，页面不显示、不下发。
        </p>
        {bark.configured ? (
          <p style={cardTextStyle}>
            未收到推送时，请先用上方「发送测试推送」核对 Bark 是否送达，再到行情设置里检查地址与 Key。
          </p>
        ) : (
          <p style={cardTextStyle}>
            尚未配置 Bark：请先到
            <Link href="/stocks/settings">行情与通知设置 → Bark</Link>
            填写服务地址和设备 Key 并保存，再回到本页「发送测试推送」核对送达。
          </p>
        )}
      </section>

      <section style={cardStyle} aria-label="调度说明">
        <h2 style={cardTitleStyle}>调度说明</h2>
        <p style={cardTextStyle}>
          当前设置：{settings.enabled ? `每天 ${hourText}（北京时间）` : "已关闭"}；上次推送：{settings.lastSentDate ?? "从未推送"}。
        </p>
        <ul style={{ ...previewListStyle, paddingLeft: 18 }}>
          <li>每天在设定的小时（Asia/Shanghai 北京时间，整点）检查一次；30 天内到期的证件合并为一条推送。</li>
          <li>每天最多推送一次：确认送达后记录当日标记（存于证件夹数据库），重启或重复检查都不会重发。</li>
          <li>推送失败或未确认送达时不记录标记，下一次检查（最长约 10 分钟后）当天内自动重试。</li>
          <li>当天没有 30 天内到期的证件时不推送；已过期证件不属于「30 天内到期」，不包含在推送里。</li>
          <li>调度器随应用启动（next start）运行；环境变量 DISABLE_SCHEDULER=1 会停用它和行情自动查询。</li>
        </ul>
      </section>

      <section style={cardStyle} aria-label="今日提醒预览">
        <h2 style={cardTitleStyle}>今天会提醒的证件（{dueDocs.length}）</h2>
        {dueDocs.length === 0 ? (
          <p style={cardTextStyle}>当前没有 30 天内到期的证件；到点不会推送。</p>
        ) : (
          <>
            <ul style={previewListStyle}>
              {dueDocs.slice(0, PREVIEW_LIMIT).map((d) => (
                <li key={d.id}>
                  {d.title} {d.expiryDate}
                  （{d.daysLeft === 0 ? "今天到期" : `还剩 ${d.daysLeft} 天`}
                  {d.holderName ? ` · ${d.holderName}` : ""}）
                </li>
              ))}
            </ul>
            {dueDocs.length > PREVIEW_LIMIT ? (
              <p style={cardTextStyle}>……等共 {dueDocs.length} 份，推送中会按持有人分组列出。</p>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
