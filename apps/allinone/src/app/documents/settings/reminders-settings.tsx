"use client";

// 证件到期提醒设置面板：提醒开关/时刻 + 立即检查 + 上次结果。
// 推送渠道配置已迁至全局推送渠道中心（独立页面 /channels，证件夹与提醒事项共用），
// 本面板保存证件夹的独立渠道选择，凭据与全局启用状态仍由 /channels 管理。

import Link from "next/link";
import { useState, useTransition } from "react";
import "./reminder-panel.css";

import { runReminderNowAction, saveReminderSettingsAction, testReminderAction, type DocumentChannelSelection } from "../reminders-actions";

type SettingsView = { enabled: boolean; hour: number; lastSentDate: string | null };

type ChannelsSummaryView = {
  bark: { enabled: boolean; local: boolean; configured: boolean; host: string; useProxy: boolean };
  feishu: { enabled: boolean; configured: boolean; useProxy: boolean };
  telegram: { enabled: boolean; configured: boolean; useProxy: boolean };
  proxy: { configured: boolean };
};

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
  channels_unavailable: "证件夹没有可用推送渠道：请至少选择一个渠道，并在「全局推送渠道」页启用且配置该渠道",
  no_due_documents: "没有 30 天内到期的证件",
  due: "已到提醒时刻",
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourLabel(hour: number): string {
  return `每天 ${String(hour).padStart(2, "0")}:00（北京时间）`;
}

function channelLines(channels: ChannelResultView[]): string {
  return channels.map((c) => `${c.name}：${c.status}${c.error ? `（${c.error}）` : ""}`).join("\n");
}

export function RemindersSettings({ initialSettings, initialChannels, initialSelection }: { initialSettings: SettingsView; initialChannels: ChannelsSummaryView; initialSelection: DocumentChannelSelection }) {
  const [selection, setSelection] = useState<DocumentChannelSelection>(initialSelection);
  const [savedSelection, setSavedSelection] = useState<DocumentChannelSelection>(initialSelection);
  const [settings, setSettings] = useState<SettingsView>(initialSettings);
  const [savedSettings, setSavedSettings] = useState<SettingsView>(initialSettings);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [lastRun, setLastRun] = useState<RunView | null>(null);
  const [saving, startSave] = useTransition();
  const [running, startRun] = useTransition();

  const save = (): void => {
    setMessage(null);
    startSave(async () => {
      const res = await saveReminderSettingsAction(settings.enabled, settings.hour, selection);
      if (res.ok) {
        setSettings(res.settings);
        setSavedSettings(res.settings);
        setSelection(res.selection);
        setSavedSelection(res.selection);
        setMessage({ tone: "ok", text: `已保存：${res.settings.enabled ? "开启" : "关闭"}，${hourLabel(res.settings.hour)}` });
      } else {
        setMessage({ tone: "error", text: res.error });
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

  const testChannels = (): void => {
    setMessage(null);
    startRun(async () => {
      const res = await testReminderAction();
      setMessage({ tone: res.ok ? "ok" : "error", text: `${res.ok ? `测试推送：${res.status}` : res.error}${res.channels.length ? `\n${channelLines(res.channels)}` : ""}` });
    });
  };

  const pending = saving || running;
  const channelKeys = ["bark", "feishu", "telegram"] as const;
  const selectionDirty = channelKeys.some((key) => selection[key] !== savedSelection[key]);
  const scheduleDirty = settings.enabled !== savedSettings.enabled || settings.hour !== savedSettings.hour || selectionDirty;
  const channels = initialChannels;
  const anySelected = channelKeys.some((key) => selection[key]);
  const anyAvailable = channelKeys.some((key) => selection[key] && channels[key].enabled && channels[key].configured);

  return (
    <div className="reminder-settings">
      <section className="reminder-panel reminder-schedule" aria-labelledby="reminder-schedule-title">
        <div className="reminder-panel-heading">
          <div>
            <p className="reminder-eyebrow">SCHEDULE</p>
            <h2 id="reminder-schedule-title">提醒计划</h2>
            <p>每天检查一次 30 天内到期的证件，合并为一条消息推送。</p>
          </div>
          <span className={`reminder-pill ${settings.enabled ? "is-on" : "is-muted"}`}>
            <span aria-hidden="true" />{scheduleDirty ? "修改待保存" : settings.enabled ? "提醒已开启" : "提醒已关闭"}
          </span>
        </div>

        <div className="reminder-schedule-grid">
          <label className="reminder-switch-row">
            <span>
              <strong>每日到期提醒</strong>
              <small>启用后按所选时间自动检查</small>
            </span>
            <input
              className="reminder-switch-input"
              type="checkbox"
              role="switch"
              checked={settings.enabled}
              disabled={pending}
              onChange={(e) => setSettings((s) => ({ ...s, enabled: e.target.checked }))}
            />
          </label>
          <label className="reminder-field reminder-hour">
            <span>提醒时间 <small>北京时间</small></span>
            <select value={settings.hour} disabled={pending} onChange={(e) => setSettings((s) => ({ ...s, hour: Number(e.target.value) }))}>
              {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </label>
        </div>

        <div className="reminder-schedule-footer">
          <p className="reminder-last-sent"><span className="reminder-clock" aria-hidden="true">◷</span> 上次推送：{settings.lastSentDate ?? "暂无记录"}{scheduleDirty ? <span className="reminder-dirty">提醒计划未保存</span> : null}</p>
          <div className="reminder-actions">
            <button type="button" className="reminder-button reminder-button-secondary" onClick={runNow} disabled={pending || scheduleDirty}>
              {running ? "检查中…" : "立即检查"}
            </button>
            <button type="button" className="reminder-button reminder-button-primary" onClick={save} disabled={pending}>
              {saving ? "保存中…" : "保存提醒设置"}
            </button>
          </div>
        </div>
        {message && <p className={`reminder-feedback is-${message.tone}`} role="status">{message.text}</p>}
        {lastRun && (
          <div className="reminder-run-result" aria-live="polite">
            <strong>上次检查结果</strong>
            <ul>
              <li>检查日期：{lastRun.today}（北京时间）</li>
              <li>到期证件：{lastRun.dueCount} 份</li>
              <li>
                推送：{lastRun.ran
                  ? lastRun.sent
                    ? `已确认送达（${lastRun.sendStatus}）`
                    : `未完全送达（${lastRun.sendStatus}${lastRun.sendError ? `：${lastRun.sendError}` : ""}）${lastRun.sendStatus === "失败" ? "，稍后将自动重试" : ""}`
                  : `未执行（${SKIP_REASONS[lastRun.reason] ?? lastRun.reason}）`}
              </li>
              {lastRun.channels.length > 0 && <li>{channelLines(lastRun.channels)}</li>}
              <li>当日推送标记：{lastRun.lastSentDate ?? "未记录"}</li>
            </ul>
          </div>
        )}
      </section>

      <section className="reminder-panel reminder-channels-link" aria-labelledby="reminder-channels-link-title">
        <div className="reminder-panel-heading">
          <div>
            <p className="reminder-eyebrow">CHANNELS</p>
            <h2 id="reminder-channels-link-title">推送渠道</h2>
            <p>选择证件夹使用的渠道；仅当渠道在全局页已启用且配置完成时才会发送。保存后生效，手动测试不受每日提醒开关限制。</p>
          </div>
          <span className={`reminder-pill ${anyAvailable ? "is-on" : "is-warning"}`}>
            <span aria-hidden="true" />{anyAvailable ? "有可用渠道" : "无可用渠道"}
          </span>
        </div>
        <div className="reminder-channel-summary">
          {channelKeys.map((key) => (
            <label key={key} className="reminder-switch-row">
              <input type="checkbox" checked={selection[key]} disabled={pending} onChange={(e) => setSelection((current) => ({ ...current, [key]: e.target.checked }))} />
              <span>{({ bark: "Bark", feishu: "飞书", telegram: "Telegram" })[key]}<small>{channels[key].enabled ? "全局已启用" : "全局未启用"} · {channels[key].configured ? "已配置" : "未配置"}</small></span>
            </label>
          ))}
        </div>
        {!anyAvailable && <p className="reminder-feedback is-error" role="status">{!anySelected ? "尚未选择证件夹推送渠道；请至少勾选一个渠道并保存。" : "所选渠道均不可用；请在全局推送渠道页启用并配置至少一个所选渠道。"}</p>}
        {scheduleDirty && <p className="reminder-last-sent">设置有未保存修改，请先保存再立即检查或发送测试。</p>}
        <div className="reminder-channel-summary">
          <span className={`reminder-pill ${channels.bark.configured ? "is-on" : "is-muted"}`}>Bark {channels.bark.configured ? `已配置（${channels.bark.host}）` : "未配置"}</span>
          <span className={`reminder-pill ${channels.feishu.configured ? "is-on" : "is-muted"}`}>飞书 {channels.feishu.configured ? "已配置" : "未配置"}</span>
          <span className={`reminder-pill ${channels.telegram.configured ? "is-on" : "is-muted"}`}>Telegram {channels.telegram.configured ? "已配置" : "未配置"}</span>
          <span className={`reminder-pill ${channels.proxy.configured ? "is-on" : "is-muted"}`}>代理 {channels.proxy.configured ? "已配置" : "未配置"}</span>
        </div>
        <div className="reminder-actions">
          <button type="button" className="reminder-button reminder-button-secondary" onClick={testChannels} disabled={pending || scheduleDirty}>{running ? "发送中…" : "发送测试"}</button>
          <button type="button" className="reminder-button reminder-button-primary" onClick={save} disabled={pending}>{saving ? "保存中…" : "保存提醒设置与渠道"}</button>
          <Link href="/channels" className="reminder-button reminder-button-secondary">前往全局推送渠道 →</Link>
        </div>
      </section>
    </div>
  );
}

export default RemindersSettings;
