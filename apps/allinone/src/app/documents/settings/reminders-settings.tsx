"use client";

// 证件到期提醒设置面板：开关 + 每日提醒时刻（Asia/Shanghai 0–23 点）+ 渠道状态 + 测试推送 + 立即检查。
// 全部变更走 Server Actions（../reminders-actions），自带状态展示（上次推送日期、跳过原因、各渠道结果）。
// 推送渠道复用行情设置的三个渠道（Bark / 飞书 / Telegram）及其启用开关，本面板不保存任何机密：
// 渠道摘要由服务端动作返回，Bark 仅显示主机名，飞书/Telegram 不显示任何配置内容。

import { useEffect, useState, useTransition, type CSSProperties } from "react";

import {
  getReminderSettingsAction,
  runReminderNowAction,
  saveReminderSettingsAction,
  testReminderAction,
} from "../reminders-actions";

type SettingsView = { enabled: boolean; hour: number; lastSentDate: string | null };

type ChannelSummaryView = { name: string; enabled: boolean; configured: boolean; host: string };

type ChannelResultView = { name: string; status: string; error: string };

type RunView = {
  ran: boolean;
  sent: boolean;
  reason: string;
  today: string;
  hour: number;
  settingsHour: number;
  enabled: boolean;
  alreadySentToday: boolean;
  dueCount: number;
  sendStatus: string;
  sendError: string;
  channels: ChannelResultView[];
  lastSentDate: string | null;
};

const SKIP_REASONS: Record<string, string> = {
  disabled: "提醒未开启",
  hour_mismatch: "未到提醒时刻（北京时间）",
  already_sent_today: "今日已推送",
  channels_unavailable: "未配置推送渠道（请在「行情与通知设置」启用 Bark / 飞书 / Telegram 至少一个）",
  no_due_documents: "没有 30 天内到期的证件",
  due: "已到提醒时刻",
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const panelStyle: CSSProperties = {
  border: "1px solid rgba(0,0,0,.12)",
  borderRadius: 12,
  padding: 16,
  display: "grid",
  gap: 12,
  maxWidth: 560,
};
const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
const bannerStyle = (tone: "ok" | "error"): CSSProperties => ({
  padding: "8px 10px",
  borderRadius: 8,
  whiteSpace: "pre-wrap",
  background: tone === "ok" ? "rgba(47,158,113,.12)" : "rgba(196,74,58,.12)",
  color: tone === "ok" ? "#1d6a4c" : "#a03d31",
});

function hourLabel(hour: number): string {
  return `每天 ${String(hour).padStart(2, "0")}:00（北京时间）`;
}

function channelStateText(channel: ChannelSummaryView): string {
  if (channel.enabled && channel.configured) return "已启用 · 已配置";
  if (channel.enabled) return "已启用但未配置";
  return "未启用";
}

function channelLines(channels: ChannelResultView[]): string {
  return channels.map((c) => `${c.name}：${c.status}${c.error ? `（${c.error}）` : ""}`).join("\n");
}

export function RemindersSettings({ initialSettings }: { initialSettings?: SettingsView }) {
  const [settings, setSettings] = useState<SettingsView>(initialSettings ?? { enabled: false, hour: 9, lastSentDate: null });
  const [channels, setChannels] = useState<ChannelSummaryView[]>([]);
  const [loaded, setLoaded] = useState(initialSettings !== undefined);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [lastRun, setLastRun] = useState<RunView | null>(null);
  const [saving, startSave] = useTransition();
  const [testing, startTest] = useTransition();
  const [running, startRun] = useTransition();

  useEffect(() => {
    if (initialSettings !== undefined) return;
    let cancelled = false;
    getReminderSettingsAction().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setSettings(res.settings);
        setChannels(res.channels);
      } else {
        setMessage({ tone: "error", text: res.error });
      }
      setLoaded(true);
    }).catch(() => {
      if (!cancelled) setMessage({ tone: "error", text: "读取提醒设置失败" });
    });
    return () => {
      cancelled = true;
    };
  }, [initialSettings]);

  const save = (): void => {
    setMessage(null);
    startSave(async () => {
      const res = await saveReminderSettingsAction(settings.enabled, settings.hour);
      if (res.ok) {
        setSettings(res.settings);
        setChannels(res.channels);
        setMessage({ tone: "ok", text: `已保存：${res.settings.enabled ? "开启" : "关闭"}，${hourLabel(res.settings.hour)}` });
      } else {
        setMessage({ tone: "error", text: res.error });
      }
    });
  };

  const test = (): void => {
    setMessage(null);
    startTest(async () => {
      const res = await testReminderAction();
      if (res.ok) {
        setMessage({
          tone: "ok",
          text: `测试推送已发送（${res.status}），请在接收端确认送达。\n${channelLines(res.channels)}`,
        });
      } else {
        setMessage({ tone: "error", text: res.channels.length > 0 ? `${res.error}\n${channelLines(res.channels)}` : res.error });
      }
    });
  };

  const runNow = (): void => {
    setMessage(null);
    startRun(async () => {
      const res = await runReminderNowAction();
      if (!res.ok) {
        setMessage({ tone: "error", text: res.error });
        return;
      }
      setLastRun(res.result);
      if (res.result.lastSentDate) setSettings((s) => ({ ...s, lastSentDate: res.result.lastSentDate }));
    });
  };

  const pending = saving || testing || running;

  return (
    <section style={panelStyle} aria-label="证件到期提醒设置">
      <div>
        <h2 style={{ margin: 0, fontSize: 16 }}>证件到期提醒</h2>
        <p style={{ margin: "4px 0 0", color: "#666", fontSize: 13 }}>
          每天在指定时刻（Asia/Shanghai）检查一次，把 30 天内到期的证件合并成一条推送；当天只推一次。
        </p>
        <p style={{ margin: "4px 0 0", color: "#666", fontSize: 13 }}>
          推送渠道复用行情设置的三个渠道及其启用开关；哪个渠道开了就用哪个，可多渠道同时推送。
        </p>
      </div>

      {!loaded && <p style={{ margin: 0, color: "#666" }}>正在读取设置…</p>}

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={pending}
          onChange={(e) => setSettings((s) => ({ ...s, enabled: e.target.checked }))}
        />
        <span>开启每日到期提醒{settings.enabled ? "（已开启）" : "（已关闭）"}</span>
      </label>

      <label style={rowStyle}>
        <span>提醒时刻</span>
        <select
          value={settings.hour}
          disabled={pending}
          onChange={(e) => setSettings((s) => ({ ...s, hour: Number(e.target.value) }))}
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>{hourLabel(h)}</option>
          ))}
        </select>
      </label>

      <dl style={{ margin: 0, display: "grid", gap: 4, fontSize: 13, color: "#444" }}>
        <div style={rowStyle}>
          <dt>状态：</dt>
          <dd style={{ margin: 0 }}>{settings.enabled ? `已开启，${hourLabel(settings.hour)}` : "已关闭"}</dd>
        </div>
        <div style={rowStyle}>
          <dt>上次推送：</dt>
          <dd style={{ margin: 0 }}>{settings.lastSentDate ?? "从未推送"}</dd>
        </div>
      </dl>

      <div style={{ borderTop: "1px dashed rgba(0,0,0,.15)", paddingTop: 10 }}>
        <p style={{ margin: "0 0 6px", fontSize: 13, color: "#444" }}>推送渠道（复用「行情与通知设置」）</p>
        {channels.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: "#666" }}>
            无法读取行情通知配置（stocks 库不可用）；推送会按「未配置渠道」跳过。
          </p>
        ) : (
          <table style={{ width: "100%", fontSize: 13, color: "#444", borderCollapse: "collapse" }}>
            <tbody>
              {channels.map((c) => (
                <tr key={c.name}>
                  <td style={{ padding: "2px 8px 2px 0" }}>{c.name}</td>
                  <td style={{ padding: "2px 8px" }}>{channelStateText(c)}</td>
                  <td style={{ padding: "2px 0", color: "#666" }}>{c.name === "Bark" && c.host ? c.host : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={rowStyle}>
        <button type="button" onClick={save} disabled={pending}>保存设置</button>
        <button type="button" onClick={test} disabled={pending || testing}>发送测试推送</button>
        <button type="button" onClick={runNow} disabled={pending || running}>立即检查</button>
      </div>

      {message && <p style={bannerStyle(message.tone)} role="status">{message.text}</p>}

      {lastRun && (
        <div style={{ borderTop: "1px dashed rgba(0,0,0,.15)", paddingTop: 10, fontSize: 13, color: "#444" }}>
          <strong>上次检查结果</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 2 }}>
            <li>检查日期（北京时间）：{lastRun.today}</li>
            <li>到期证件：{lastRun.dueCount} 份</li>
            <li>
              推送：
              {lastRun.ran
                ? lastRun.sent
                  ? `已确认送达（${lastRun.sendStatus}）`
                  : `未完全送达（${lastRun.sendStatus}${lastRun.sendError ? `：${lastRun.sendError}` : ""}）${
                      lastRun.sendStatus === "失败" ? "，稍后将自动重试" : ""
                    }`
                : `未执行（${SKIP_REASONS[lastRun.reason] ?? lastRun.reason}）`}
            </li>
            {lastRun.channels.length > 0 && <li>{channelLines(lastRun.channels)}</li>}
            <li>当日推送标记：{lastRun.lastSentDate ?? "未记录（失败会自动重试）"}</li>
          </ul>
        </div>
      )}
    </section>
  );
}

export default RemindersSettings;
