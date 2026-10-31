"use client";

// 证件到期提醒设置面板：提醒开关/时刻 + 独立的推送渠道配置表单（Bark / 飞书 / Telegram + 共享代理）
// + 渠道状态 + 测试推送（单渠道/全部）+ 从行情设置一次性导入 + 立即检查。
// 渠道配置保存在证件夹数据库（reminder_channels），与行情（TickerSentry）设置相互独立；
// 表单显示已保存的完整配置。保存时只提交发生变化且非空的文本，留空仍表示保持现有值。

import { useRef, useState, useTransition, type CSSProperties } from "react";
import type { ChannelConfig } from "@/modules/stocks/notify";

import {
  clearReminderChannelAction,
  importChannelsFromStocksAction,
  runReminderNowAction,
  saveReminderChannelsAction,
  saveReminderSettingsAction,
  testReminderAction,
  testReminderChannelAction,
} from "../reminders-actions";

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

/** 表单状态直接展示证件夹渠道配置。 */
type ChannelsFormState = {
  barkEnabled: boolean;
  barkUrl: string;
  barkKey: string;
  barkLocal: boolean;
  barkProxy: boolean;
  feishuEnabled: boolean;
  feishuWebhook: string;
  feishuSecret: string;
  feishuProxy: boolean;
  tgEnabled: boolean;
  tgToken: string;
  tgChatId: string;
  tgProxy: boolean;
  proxyUrl: string;
};

function formFromConfig(config: ChannelConfig): ChannelsFormState {
  return {
    barkEnabled: config.BarkEnabled,
    barkUrl: config.Bark.URL,
    barkKey: config.Bark.Key,
    barkLocal: config.Bark.Local,
    barkProxy: config.BarkProxy,
    feishuEnabled: config.FeishuEnabled,
    feishuWebhook: config.FeishuWebhook,
    feishuSecret: config.FeishuSecret,
    feishuProxy: config.FeishuProxy,
    tgEnabled: config.TGEnabled,
    tgToken: config.TGToken,
    tgChatId: config.TGChatID,
    tgProxy: config.TGProxy,
    proxyUrl: config.Proxy,
  };
}

const SKIP_REASONS: Record<string, string> = {
  disabled: "提醒未开启",
  hour_mismatch: "未到提醒时刻（北京时间）",
  already_sent_today: "今日已推送",
  channels_unavailable: "未配置推送渠道（请在下方启用并配置 Bark / 飞书 / Telegram 至少一个）",
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
  maxWidth: 640,
};
const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
const fieldStyle: CSSProperties = { display: "grid", gap: 2, minWidth: 240, flex: "1 1 240px" };
const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid rgba(127,127,127,.4)",
  background: "transparent",
  color: "inherit",
  fontSize: 13,
};
const sectionStyle: CSSProperties = {
  borderTop: "1px dashed rgba(0,0,0,.15)",
  paddingTop: 10,
  display: "grid",
  gap: 8,
};
const channelHeadStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
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

function stateText(enabled: boolean, configured: boolean): string {
  if (enabled && configured) return "已启用 · 已配置";
  if (enabled) return "已启用但未配置";
  return "未启用";
}

function channelLines(channels: ChannelResultView[]): string {
  return channels.map((c) => `${c.name}：${c.status}${c.error ? `（${c.error}）` : ""}`).join("\n");
}

export function RemindersSettings({ initialSettings, initialChannels, initialConfig }: { initialSettings: SettingsView; initialChannels: ChannelsSummaryView; initialConfig: ChannelConfig }) {
  const [settings, setSettings] = useState<SettingsView>(initialSettings);
  const [summary, setSummary] = useState<ChannelsSummaryView>(initialChannels);
  const [form, setForm] = useState<ChannelsFormState>(() => formFromConfig(initialConfig));
  const savedForm = useRef<ChannelsFormState>(formFromConfig(initialConfig));
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [channelMessage, setChannelMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [lastRun, setLastRun] = useState<RunView | null>(null);
  const [saving, startSave] = useTransition();
  const [savingChannels, startSaveChannels] = useTransition();
  const [testing, startTest] = useTransition();
  const [testingName, setTestingName] = useState<string | null>(null);
  const [importing, startImport] = useTransition();
  const [running, startRun] = useTransition();

  const applySaved = (next: ChannelsSummaryView, config: ChannelConfig): void => {
    const saved = formFromConfig(config);
    savedForm.current = saved;
    setSummary(next);
    setForm(saved);
  };

  const save = (): void => {
    setMessage(null);
    startSave(async () => {
      const res = await saveReminderSettingsAction(settings.enabled, settings.hour);
      if (res.ok) {
        setSettings(res.settings);
        setSummary(res.channels);
        setMessage({ tone: "ok", text: `已保存：${res.settings.enabled ? "开启" : "关闭"}，${hourLabel(res.settings.hour)}` });
      } else {
        setMessage({ tone: "error", text: res.error });
      }
    });
  };

  /** 仅提交改动且非空的文本字段，未改动的配置由服务端保留。 */
  const saveChannels = (): void => {
    setChannelMessage(null);
    startSaveChannels(async () => {
      const input: Record<string, unknown> = {
        barkEnabled: form.barkEnabled,
        barkLocal: form.barkLocal,
        barkProxy: form.barkProxy,
        feishuEnabled: form.feishuEnabled,
        feishuProxy: form.feishuProxy,
        tgEnabled: form.tgEnabled,
        tgProxy: form.tgProxy,
      };
      const textKeys = ["barkUrl", "barkKey", "feishuWebhook", "feishuSecret", "tgToken", "tgChatId", "proxyUrl"] as const;
      for (const key of textKeys) {
        if (form[key].trim() !== "" && form[key] !== savedForm.current[key]) input[key] = form[key];
      }
      const res = await saveReminderChannelsAction(input);
      if (res.ok) {
        applySaved(res.channels, res.config);
        setChannelMessage({ tone: "ok", text: "渠道配置已保存（留空字段保持原值）。" });
      } else {
        setSummary(res.channels);
        setChannelMessage({ tone: "error", text: res.error });
      }
    });
  };

  const test = (): void => {
    setChannelMessage(null);
    startTest(async () => {
      const res = await testReminderAction();
      if (res.ok) {
        setChannelMessage({ tone: res.status === "成功" ? "ok" : "error", text: `测试结果：${res.status}\n${channelLines(res.channels)}` });
      } else {
        setChannelMessage({ tone: "error", text: `${res.error}${res.channels.length ? `\n${channelLines(res.channels)}` : ""}` });
      }
    });
  };

  const testChannel = (name: string): void => {
    setChannelMessage(null);
    setTestingName(name);
    startTest(async () => {
      try {
        const res = await testReminderChannelAction(name);
        setChannelMessage(
          res.ok
            ? { tone: "ok", text: `${name} 测试推送已发送，请在接收端确认送达。` }
            : { tone: "error", text: `${name}：${res.error}` },
        );
      } finally {
        setTestingName(null);
      }
    });
  };

  const clearChannel = (name: "Bark" | "飞书" | "Telegram" | "代理"): void => {
    if (!window.confirm(`确定清除「${name}」的证件提醒配置？此操作会删除已保存的地址和密钥。`)) return;
    setChannelMessage(null);
    startSaveChannels(async () => {
      const res = await clearReminderChannelAction(name);
      if (res.ok) {
        applySaved(res.channels, res.config);
        setChannelMessage({ tone: "ok", text: `已清除 ${name} 配置。` });
      } else {
        setChannelMessage({ tone: "error", text: res.error });
      }
    });
  };

  const importFromStocks = (): void => {
    if (!window.confirm("将从「行情与通知设置」读取 Bark / 飞书 / Telegram 配置，并覆盖当前证件夹渠道配置（含清空多余的机密字段）。确定导入？")) {
      return;
    }
    setChannelMessage(null);
    startImport(async () => {
      const res = await importChannelsFromStocksAction();
      if (res.ok) {
        applySaved(res.channels, res.config);
        setChannelMessage({ tone: "ok", text: "已从行情设置导入并覆盖当前渠道配置。" });
      } else {
        setChannelMessage({ tone: "error", text: res.error });
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

  const pending = saving || savingChannels || testing || importing || running;

  return (
    <section style={panelStyle} aria-label="证件到期提醒设置">
      <div>
        <h2 style={{ margin: 0, fontSize: 16 }}>证件到期提醒</h2>
        <p style={{ margin: "4px 0 0", color: "#666", fontSize: 13 }}>
          每天在指定时刻（Asia/Shanghai）检查一次，把 30 天内到期的证件合并成一条推送；当天只推一次。
        </p>
        <p style={{ margin: "4px 0 0", color: "#666", fontSize: 13 }}>
          推送渠道在证件夹独立配置（保存在证件夹数据库）；哪个渠道开了就用哪个，可多渠道同时推送。
        </p>
      </div>

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
        <div style={rowStyle}>
          <dt>渠道：</dt>
          <dd style={{ margin: 0 }}>
            Bark {stateText(summary.bark.enabled, summary.bark.configured)} · 飞书 {stateText(summary.feishu.enabled, summary.feishu.configured)} · Telegram {stateText(summary.telegram.enabled, summary.telegram.configured)}
          </dd>
        </div>
      </dl>

      <div style={rowStyle}>
        <button type="button" onClick={save} disabled={pending}>保存设置</button>
        <button type="button" onClick={runNow} disabled={pending || running}>立即检查</button>
      </div>

      {message && <p style={bannerStyle(message.tone)} role="status">{message.text}</p>}

      {/* —— 推送渠道（独立配置） —— */}
      <div style={sectionStyle}>
        <div style={channelHeadStyle}>
          <strong style={{ fontSize: 14 }}>推送渠道</strong>
          <span style={{ color: "#666", fontSize: 12 }}>
            已保存的配置完整显示；留空保存时保持原值，清除请使用对应按钮
          </span>
        </div>

        <fieldset style={{ border: "1px solid rgba(127,127,127,.3)", borderRadius: 8, padding: 10, display: "grid", gap: 8 }}>
          <legend style={channelHeadStyle}>
            <label style={rowStyle}>
              <input
                type="checkbox"
                checked={form.barkEnabled}
                disabled={pending}
                onChange={(e) => setForm((f) => ({ ...f, barkEnabled: e.target.checked }))}
              />
              <strong>Bark</strong>
            </label>
            <span style={{ color: "#666", fontSize: 12 }}>{stateText(form.barkEnabled, summary.bark.configured)}{summary.bark.configured && summary.bark.host ? `（${summary.bark.host}）` : ""}</span>
            <button type="button" onClick={() => testChannel("Bark")} disabled={pending}>测试</button>
            <button type="button" onClick={() => clearChannel("Bark")} disabled={pending}>清除配置</button>
          </legend>
          <label style={fieldStyle}>
            <span>服务地址</span>
            <input
              style={inputStyle}
              type="text"
              value={form.barkUrl}
              placeholder={summary.bark.configured ? `已配置（${summary.bark.host || "Bark 服务"}），留空保持不变` : "https://api.day.app"}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, barkUrl: e.target.value }))}
            />
          </label>
          <label style={fieldStyle}>
            <span>设备 Key</span>
            <input
              style={inputStyle}
              type="text"
              value={form.barkKey}
              placeholder={summary.bark.configured ? "已配置，留空保持不变" : "Bark 设备 Key"}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, barkKey: e.target.value }))}
            />
          </label>
          <label style={rowStyle}>
            <input
              type="checkbox"
              checked={form.barkLocal}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, barkLocal: e.target.checked }))}
            />
            <span>允许内网 HTTP 地址</span>
          </label>
          <label style={rowStyle}>
            <input
              type="checkbox"
              checked={form.barkProxy}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, barkProxy: e.target.checked }))}
            />
            <span>使用代理</span>
          </label>
        </fieldset>

        <fieldset style={{ border: "1px solid rgba(127,127,127,.3)", borderRadius: 8, padding: 10, display: "grid", gap: 8 }}>
          <legend style={channelHeadStyle}>
            <label style={rowStyle}>
              <input
                type="checkbox"
                checked={form.feishuEnabled}
                disabled={pending}
                onChange={(e) => setForm((f) => ({ ...f, feishuEnabled: e.target.checked }))}
              />
              <strong>飞书</strong>
            </label>
            <span style={{ color: "#666", fontSize: 12 }}>{stateText(form.feishuEnabled, summary.feishu.configured)}</span>
            <button type="button" onClick={() => testChannel("飞书")} disabled={pending}>测试</button>
            <button type="button" onClick={() => clearChannel("飞书")} disabled={pending}>清除配置</button>
          </legend>
          <label style={fieldStyle}>
            <span>群机器人 Webhook</span>
            <input
              style={inputStyle}
              type="text"
              value={form.feishuWebhook}
              placeholder={summary.feishu.configured ? "已配置，留空保持不变" : "https://open.feishu.cn/open-apis/bot/v2/hook/…"}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, feishuWebhook: e.target.value }))}
            />
          </label>
          <label style={fieldStyle}>
            <span>签名 Secret（可选）</span>
            <input
              style={inputStyle}
              type="text"
              value={form.feishuSecret}
              placeholder={summary.feishu.configured ? "已配置，留空保持不变" : "开启签名校验时填写"}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, feishuSecret: e.target.value }))}
            />
          </label>
          <label style={rowStyle}>
            <input
              type="checkbox"
              checked={form.feishuProxy}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, feishuProxy: e.target.checked }))}
            />
            <span>使用代理</span>
          </label>
        </fieldset>

        <fieldset style={{ border: "1px solid rgba(127,127,127,.3)", borderRadius: 8, padding: 10, display: "grid", gap: 8 }}>
          <legend style={channelHeadStyle}>
            <label style={rowStyle}>
              <input
                type="checkbox"
                checked={form.tgEnabled}
                disabled={pending}
                onChange={(e) => setForm((f) => ({ ...f, tgEnabled: e.target.checked }))}
              />
              <strong>Telegram</strong>
            </label>
            <span style={{ color: "#666", fontSize: 12 }}>{stateText(form.tgEnabled, summary.telegram.configured)}</span>
            <button type="button" onClick={() => testChannel("Telegram")} disabled={pending}>测试</button>
            <button type="button" onClick={() => clearChannel("Telegram")} disabled={pending}>清除配置</button>
          </legend>
          <label style={fieldStyle}>
            <span>Bot Token</span>
            <input
              style={inputStyle}
              type="text"
              value={form.tgToken}
              placeholder={summary.telegram.configured ? "已配置，留空保持不变" : "1234567890:AA…"}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, tgToken: e.target.value }))}
            />
          </label>
          <label style={fieldStyle}>
            <span>数字 Chat ID</span>
            <input
              style={inputStyle}
              type="text"
              value={form.tgChatId}
              placeholder={summary.telegram.configured ? "已配置，留空保持不变" : "如 123456789"}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, tgChatId: e.target.value }))}
            />
          </label>
          <label style={rowStyle}>
            <input
              type="checkbox"
              checked={form.tgProxy}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, tgProxy: e.target.checked }))}
            />
            <span>使用代理</span>
          </label>
        </fieldset>

        <label style={fieldStyle}>
          <span>共享代理地址{summary.proxy.configured ? "（已配置）" : ""}</span>
          <input
            style={inputStyle}
            type="text"
            value={form.proxyUrl}
            placeholder={summary.proxy.configured ? "已配置，留空保持不变" : "http://或 socks5:// 地址和端口"}
            disabled={pending}
            onChange={(e) => setForm((f) => ({ ...f, proxyUrl: e.target.value }))}
          />
        </label>

        <div style={rowStyle}>
          <button type="button" onClick={() => clearChannel("代理")} disabled={pending}>清除代理</button>
          <button type="button" onClick={saveChannels} disabled={pending}>保存渠道配置</button>
          <button type="button" onClick={test} disabled={pending || testing}>发送测试推送</button>
          <button type="button" onClick={importFromStocks} disabled={pending}>从行情设置导入（覆盖当前渠道配置）</button>
        </div>

        {channelMessage && <p style={bannerStyle(channelMessage.tone)} role="status">{channelMessage.text}</p>}
      </div>

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
