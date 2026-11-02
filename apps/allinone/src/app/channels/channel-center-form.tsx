"use client";

// 全局推送渠道配置表单：Bark / 飞书 / Telegram + 共享代理。
// 从证件夹设置面板整体迁出（视觉类名沿用 reminder-panel.css，两处页面共用同一套表单样式）；
// 配置保存在全局推送渠道中心，证件夹与提醒事项共用。保存只提交变化且非空的文本字段。

import { useRef, useState, useTransition } from "react";
import type { ChannelConfig } from "@/modules/stocks/notify";
import "../documents/settings/reminder-panel.css";

import { clearChannelAction, saveChannelsAction, testChannelAction, testChannelsAction } from "./actions";

type ChannelsSummaryView = {
  bark: { enabled: boolean; local: boolean; configured: boolean; host: string; useProxy: boolean };
  feishu: { enabled: boolean; configured: boolean; useProxy: boolean };
  telegram: { enabled: boolean; configured: boolean; useProxy: boolean };
  proxy: { configured: boolean };
};

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

function stateText(enabled: boolean, configured: boolean): string {
  if (enabled && configured) return "已启用 · 已配置";
  if (enabled) return "已启用但未配置";
  return "未启用";
}

function channelLines(channels: Array<{ name: string; status: string; error: string }>): string {
  return channels.map((c) => `${c.name}：${c.status}${c.error ? `（${c.error}）` : ""}`).join("\n");
}

export function ChannelCenterForm({ initialChannels, initialConfig }: { initialChannels: ChannelsSummaryView; initialConfig: ChannelConfig }) {
  const [summary, setSummary] = useState<ChannelsSummaryView>(initialChannels);
  const [form, setForm] = useState<ChannelsFormState>(() => formFromConfig(initialConfig));
  const savedForm = useRef<ChannelsFormState>(formFromConfig(initialConfig));
  const [channelMessage, setChannelMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [channelNoticeTarget, setChannelNoticeTarget] = useState<string | null>(null);
  const [savingChannels, startSaveChannels] = useTransition();
  const [testing, startTest] = useTransition();
  const [testingName, setTestingName] = useState<string | null>(null);

  const applySaved = (next: ChannelsSummaryView, config: ChannelConfig): void => {
    const saved = formFromConfig(config);
    savedForm.current = saved;
    setSummary(next);
    setForm(saved);
  };

  /** 仅提交改动且非空的文本字段，未改动的配置由服务端保留。 */
  const saveChannels = (): void => {
    setChannelNoticeTarget(null);
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
      const res = await saveChannelsAction(input);
      if (res.ok) {
        applySaved(res.channels, res.config);
        setChannelMessage({ tone: "ok", text: "渠道配置已保存（留空字段保持原值）。" });
      } else {
        setSummary(res.channels);
        setChannelMessage({ tone: "error", text: res.error });
      }
    });
  };

  const testAll = (): void => {
    setChannelNoticeTarget(null);
    setChannelMessage(null);
    startTest(async () => {
      const res = await testChannelsAction();
      if (res.ok) {
        setChannelMessage({ tone: res.status === "成功" ? "ok" : "error", text: `测试结果：${res.status}\n${channelLines(res.channels)}` });
      } else {
        setChannelMessage({ tone: "error", text: `${res.error}${res.channels.length ? `\n${channelLines(res.channels)}` : ""}` });
      }
    });
  };

  const testChannel = (name: string): void => {
    setChannelNoticeTarget(name);
    setChannelMessage(null);
    setTestingName(name);
    startTest(async () => {
      try {
        const res = await testChannelAction(name);
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
    if (!window.confirm(`确定清除「${name}」的渠道配置？此操作会删除已保存的地址和密钥。`)) return;
    setChannelNoticeTarget(name);
    setChannelMessage(null);
    startSaveChannels(async () => {
      const res = await clearChannelAction(name);
      if (res.ok) {
        applySaved(res.channels, res.config);
        setChannelMessage({ tone: "ok", text: `已清除 ${name} 配置。` });
      } else {
        setChannelMessage({ tone: "error", text: res.error });
      }
    });
  };

  const pending = savingChannels || testing;
  const channelsDirty = (Object.keys(form) as Array<keyof ChannelsFormState>).some((key) => form[key] !== savedForm.current[key]);

  return (
    <section className="reminder-channels" aria-labelledby="reminder-channels-title">
      <div className="reminder-channels-heading">
        <div>
          <p className="reminder-eyebrow">CHANNELS</p>
          <h2 id="reminder-channels-title">推送渠道</h2>
          <p>开启需要的渠道，可以同时发送到多个平台。证件夹到期提醒与提醒事项共用这份配置。</p>
        </div>
      </div>

      <fieldset className="reminder-channel">
        <legend className="reminder-sr-only">Bark 推送配置</legend>
        <div className="reminder-channel-header">
          <div className="reminder-channel-title">
            <span className="reminder-channel-icon is-bark" aria-hidden="true">B</span>
            <div><h3>Bark</h3><p>通过 Bark 将提醒发送到设备</p></div>
          </div>
          <div className="reminder-channel-controls">
            <span className={`reminder-pill ${form.barkEnabled && summary.bark.configured ? "is-on" : form.barkEnabled ? "is-warning" : "is-muted"}`}><span aria-hidden="true" />{form.barkEnabled !== savedForm.current.barkEnabled ? "待保存" : stateText(form.barkEnabled, summary.bark.configured)}</span>
            <label className="reminder-channel-switch"><span className="reminder-sr-only">启用 Bark</span><input type="checkbox" role="switch" checked={form.barkEnabled} disabled={pending} onChange={(e) => setForm((f) => ({ ...f, barkEnabled: e.target.checked }))} /></label>
          </div>
        </div>
        <div className="reminder-channel-fields">
          <label className="reminder-field"><span>服务地址</span><input type="text" value={form.barkUrl} placeholder="https://api.day.app" disabled={pending} onChange={(e) => setForm((f) => ({ ...f, barkUrl: e.target.value }))} /></label>
          <label className="reminder-field"><span>设备 Key</span><input type="text" value={form.barkKey} placeholder="填写 Bark 设备 Key" disabled={pending} onChange={(e) => setForm((f) => ({ ...f, barkKey: e.target.value }))} /></label>
        </div>
        <div className="reminder-channel-footer">
          <div className="reminder-options">
            <label><input type="checkbox" checked={form.barkLocal} disabled={pending} onChange={(e) => setForm((f) => ({ ...f, barkLocal: e.target.checked }))} />允许内网 HTTP 地址</label>
            <label><input type="checkbox" checked={form.barkProxy} disabled={pending} onChange={(e) => setForm((f) => ({ ...f, barkProxy: e.target.checked }))} />使用代理</label>
          </div>
          <div className="reminder-actions">
            <button type="button" className="reminder-button reminder-button-danger" onClick={() => clearChannel("Bark")} disabled={pending}>清除配置</button>
            <button type="button" className="reminder-button reminder-button-secondary" onClick={() => testChannel("Bark")} disabled={pending}>{testingName === "Bark" ? "测试中…" : "测试 Bark"}</button>
          </div>
        </div>
        {channelNoticeTarget === "Bark" && channelMessage ? <p className={`reminder-feedback reminder-local-feedback is-${channelMessage.tone}`} role="status">{channelMessage.text}</p> : null}
      </fieldset>

      <fieldset className="reminder-channel">
        <legend className="reminder-sr-only">飞书推送配置</legend>
        <div className="reminder-channel-header">
          <div className="reminder-channel-title">
            <span className="reminder-channel-icon is-feishu" aria-hidden="true">飞</span>
            <div><h3>飞书</h3><p>发送到飞书群机器人</p></div>
          </div>
          <div className="reminder-channel-controls">
            <span className={`reminder-pill ${form.feishuEnabled && summary.feishu.configured ? "is-on" : form.feishuEnabled ? "is-warning" : "is-muted"}`}><span aria-hidden="true" />{form.feishuEnabled !== savedForm.current.feishuEnabled ? "待保存" : stateText(form.feishuEnabled, summary.feishu.configured)}</span>
            <label className="reminder-channel-switch"><span className="reminder-sr-only">启用飞书</span><input type="checkbox" role="switch" checked={form.feishuEnabled} disabled={pending} onChange={(e) => setForm((f) => ({ ...f, feishuEnabled: e.target.checked }))} /></label>
          </div>
        </div>
        <div className="reminder-channel-fields">
          <label className="reminder-field"><span>群机器人 Webhook</span><input type="text" value={form.feishuWebhook} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" disabled={pending} onChange={(e) => setForm((f) => ({ ...f, feishuWebhook: e.target.value }))} /></label>
          <label className="reminder-field"><span>签名 Secret <small>可选</small></span><input type="text" value={form.feishuSecret} placeholder="开启签名校验时填写" disabled={pending} onChange={(e) => setForm((f) => ({ ...f, feishuSecret: e.target.value }))} /></label>
        </div>
        <div className="reminder-channel-footer">
          <div className="reminder-options"><label><input type="checkbox" checked={form.feishuProxy} disabled={pending} onChange={(e) => setForm((f) => ({ ...f, feishuProxy: e.target.checked }))} />使用代理</label></div>
          <div className="reminder-actions">
            <button type="button" className="reminder-button reminder-button-danger" onClick={() => clearChannel("飞书")} disabled={pending}>清除配置</button>
            <button type="button" className="reminder-button reminder-button-secondary" onClick={() => testChannel("飞书")} disabled={pending}>{testingName === "飞书" ? "测试中…" : "测试飞书"}</button>
          </div>
        </div>
        {channelNoticeTarget === "飞书" && channelMessage ? <p className={`reminder-feedback reminder-local-feedback is-${channelMessage.tone}`} role="status">{channelMessage.text}</p> : null}
      </fieldset>

      <fieldset className="reminder-channel">
        <legend className="reminder-sr-only">Telegram 推送配置</legend>
        <div className="reminder-channel-header">
          <div className="reminder-channel-title">
            <span className="reminder-channel-icon is-telegram" aria-hidden="true">➤</span>
            <div><h3>Telegram</h3><p>发送到机器人会话或群组</p></div>
          </div>
          <div className="reminder-channel-controls">
            <span className={`reminder-pill ${form.tgEnabled && summary.telegram.configured ? "is-on" : form.tgEnabled ? "is-warning" : "is-muted"}`}><span aria-hidden="true" />{form.tgEnabled !== savedForm.current.tgEnabled ? "待保存" : stateText(form.tgEnabled, summary.telegram.configured)}</span>
            <label className="reminder-channel-switch"><span className="reminder-sr-only">启用 Telegram</span><input type="checkbox" role="switch" checked={form.tgEnabled} disabled={pending} onChange={(e) => setForm((f) => ({ ...f, tgEnabled: e.target.checked }))} /></label>
          </div>
        </div>
        <div className="reminder-channel-fields">
          <label className="reminder-field"><span>Bot Token</span><input type="text" value={form.tgToken} placeholder="1234567890:AA…" disabled={pending} onChange={(e) => setForm((f) => ({ ...f, tgToken: e.target.value }))} /></label>
          <label className="reminder-field"><span>数字 Chat ID</span><input type="text" value={form.tgChatId} placeholder="如 123456789" disabled={pending} onChange={(e) => setForm((f) => ({ ...f, tgChatId: e.target.value }))} /></label>
        </div>
        <div className="reminder-channel-footer">
          <div className="reminder-options"><label><input type="checkbox" checked={form.tgProxy} disabled={pending} onChange={(e) => setForm((f) => ({ ...f, tgProxy: e.target.checked }))} />使用代理</label></div>
          <div className="reminder-actions">
            <button type="button" className="reminder-button reminder-button-danger" onClick={() => clearChannel("Telegram")} disabled={pending}>清除配置</button>
            <button type="button" className="reminder-button reminder-button-secondary" onClick={() => testChannel("Telegram")} disabled={pending}>{testingName === "Telegram" ? "测试中…" : "测试 Telegram"}</button>
          </div>
        </div>
        {channelNoticeTarget === "Telegram" && channelMessage ? <p className={`reminder-feedback reminder-local-feedback is-${channelMessage.tone}`} role="status">{channelMessage.text}</p> : null}
      </fieldset>

      <div className="reminder-proxy">
        <div className="reminder-proxy-heading"><div><h3>代理设置</h3><p>需要代理的渠道请在上方单独勾选。</p></div><span className={`reminder-pill ${summary.proxy.configured ? "is-on" : "is-muted"}`}><span aria-hidden="true" />{summary.proxy.configured ? "已配置" : "未配置"}</span></div>
        <label className="reminder-field"><span>共享代理地址</span><input type="text" value={form.proxyUrl} placeholder="http:// 或 socks5:// 地址和端口" disabled={pending} onChange={(e) => setForm((f) => ({ ...f, proxyUrl: e.target.value }))} /></label>
        <button type="button" className="reminder-button reminder-button-danger" onClick={() => clearChannel("代理")} disabled={pending}>清除代理</button>
        {channelNoticeTarget === "代理" && channelMessage ? <p className={`reminder-feedback is-${channelMessage.tone}`} role="status">{channelMessage.text}</p> : null}
      </div>

      <div className="reminder-save-bar">
        <p>{channelsDirty ? <strong className="reminder-dirty">渠道配置有未保存的修改。 </strong> : null}已保存的配置完整显示。留空保存时保持原值，清除请使用对应按钮。</p>
        <div className="reminder-actions">
          <button type="button" className="reminder-button reminder-button-secondary" onClick={testAll} disabled={pending || testing}>{testing && !testingName ? "发送中…" : "发送测试推送"}</button>
          <button type="button" className="reminder-button reminder-button-primary" onClick={saveChannels} disabled={pending}>{savingChannels ? "保存中…" : "保存渠道配置"}</button>
        </div>
      </div>
      {channelNoticeTarget === null && channelMessage && <p className={`reminder-feedback is-${channelMessage.tone}`} role="status">{channelMessage.text}</p>}
    </section>
  );
}

export default ChannelCenterForm;
