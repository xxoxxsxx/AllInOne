import Link from "next/link";
import type { CSSProperties } from "react";

import { todayStr } from "@/lib/documents/constants";
import { getDocumentsDB, listDocuments } from "@/lib/documents/db";
import { getReminderSettings, selectExpiringDocuments } from "@/lib/documents/reminders";
import { getReminderChannels, summarizeChannels } from "@/lib/documents/reminders-channels";

import { RemindersSettings } from "./reminders-settings";

export const dynamic = "force-dynamic";

export const metadata = { title: "到期提醒设置 · 证件夹" };

// /documents/settings 路由页：服务端读取提醒设置与推送渠道（Bark/飞书/Telegram）状态后挂载设置面板。
// 渠道配置保存在证件夹自己的 reminder_channels 表（documents.db），独立于行情设置；
// 页面展示完整渠道配置，供查看和编辑。面板本体在 ./reminders-settings.tsx。

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

type ChannelLine = { name: string; enabled: boolean; configured: boolean; host?: string };

function channelStateText(channel: ChannelLine): string {
  if (channel.enabled && channel.configured) {
    return channel.host ? `已启用 · 已配置（${channel.host}）` : "已启用 · 已配置";
  }
  if (channel.enabled) return "已启用但未配置（在本页补全后才会推送）";
  return "未启用";
}

export default async function ReminderSettingsPage() {
  const db = getDocumentsDB();
  const settings = getReminderSettings(db);
  const dueDocs = selectExpiringDocuments(listDocuments(db, todayStr()));
  // 渠道配置读取自证件夹自己的 reminder_channels 表，回显已保存的完整配置。
  const channelConfig = getReminderChannels(db);
  const channels0 = summarizeChannels(channelConfig);
  const channels: ChannelLine[] = [
    { name: "Bark", enabled: channels0.bark.enabled, configured: channels0.bark.configured, host: channels0.bark.host },
    { name: "飞书", enabled: channels0.feishu.enabled, configured: channels0.feishu.configured },
    { name: "Telegram", enabled: channels0.telegram.enabled, configured: channels0.telegram.configured },
  ];
  const anyUsable = channels.some((c) => c.enabled && c.configured);
  const schedulerDisabled = process.env.DISABLE_SCHEDULER === "1";
  const hourText = `${String(settings.hour).padStart(2, "0")}:00`;

  return (
    <main className="docs-page">
      <Link href="/documents" className="docs-back">← 证件夹</Link>
      <header className="docs-hero">
        <p className="docs-kicker">Document Vault</p>
        <h1 className="docs-title">到期提醒</h1>
        <p className="docs-sub">每天把 30 天内到期的证件合并成一条推送（Bark / 飞书 / Telegram），每天最多一次。</p>
      </header>

      {schedulerDisabled ? (
        <p style={warnStyle} role="status">
          内置调度器已禁用（DISABLE_SCHEDULER=1）：设置仍会保存，但提醒不会自动发送；如需自动推送请在部署环境移除该变量。
        </p>
      ) : null}

      <RemindersSettings initialSettings={settings} initialChannels={channels0} initialConfig={channelConfig} />

      <section style={cardStyle} aria-label="推送渠道说明">
        <h2 style={cardTitleStyle}>推送渠道：在证件夹独立配置</h2>
        <p style={cardTextStyle}>
          Bark / 飞书 / Telegram 在本页直接配置（保存在证件夹数据库，与行情设置互相独立）；
          哪个渠道开了就用哪个，可多渠道同时推送。
        </p>
        <ul style={previewListStyle}>
          {channels.map((c) => (
            <li key={c.name}>{c.name}：{channelStateText(c)}</li>
          ))}
        </ul>
        <p style={cardTextStyle}>
          渠道地址、Key、Webhook、Token 等会在设置页完整显示；表单里留空的字段保存时保持现有值。如需迁移，可用上方
          「从行情设置导入」一次性覆盖当前渠道配置（可选的手动操作，平时不读取行情设置）。
          升级前使用行情渠道的用户，需要在本页配置或手动导入一次后才会继续接收证件提醒。
        </p>
        {anyUsable ? (
          <p style={cardTextStyle}>
            未收到推送时，请先用对应渠道的「测试」按钮或「发送测试推送」核对是否送达，再检查渠道配置。
          </p>
        ) : (
          <p style={cardTextStyle}>
            尚未启用任何渠道：请在上方「推送渠道」中启用并配置 Bark / 飞书 / Telegram 至少一个渠道，
            保存后用「发送测试推送」核对送达。
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
          <li>所有渠道都明确失败时不记录标记，下一次检查（最长约 10 分钟后）当天内自动重试；部分成功或结果不确定时不重发，以免重复通知。</li>
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
