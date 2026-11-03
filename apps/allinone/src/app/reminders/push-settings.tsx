"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import type { ModulePolicy } from "@/lib/channels/module-policy";
import { saveReminderPushPolicyAction } from "./actions";

const CHANNELS = [
  { key: "bark", name: "Bark", desc: "iPhone 推送" },
  { key: "feishu", name: "飞书", desc: "群机器人" },
  { key: "telegram", name: "Telegram", desc: "Bot 会话" },
] as const;

export function ReminderPushSettings({ initial }: { initial: ModulePolicy }) {
  const [policy, setPolicy] = useState(initial);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(policy) !== JSON.stringify(initial);
  const toggle = (key: keyof ModulePolicy, checked: boolean) => setPolicy(p => ({ ...p, [key]: checked }));
  return <section className="rem-push-settings" aria-label="提醒事项推送设置">
    <div className="rem-push-head">
      <div>
        <h2>推送设置</h2>
        <p className="rem-push-sub">仅控制提醒事项的自动推送；单条提醒仍可单独暂停。关闭期间保留计划，重新开启后按错过规则处理。</p>
      </div>
      <label className="rem-push-switch">
        <input type="checkbox" role="switch" checked={policy.enabled} onChange={e => toggle("enabled", e.target.checked)} />
        <span>{policy.enabled ? "自动推送已开启" : "自动推送已关闭"}</span>
      </label>
    </div>

    <div className="rem-push-channels">
      {CHANNELS.map(({ key, name, desc }) => (
        <label key={key} className={`rem-push-channel ${policy[key] ? "is-on" : ""}`}>
          <input type="checkbox" checked={policy[key]} onChange={e => toggle(key, e.target.checked)} />
          <span className="rem-push-channel-name">{name}</span>
          <span className="rem-push-channel-desc">{desc}</span>
        </label>
      ))}
      <p className="rem-push-note">实际发送 = 渠道已在 <Link href="/channels">全局推送渠道</Link> 中启用 且 此处勾选。手动「立即测试」不受自动开关影响。</p>
    </div>

    <div className="rem-push-foot">
      <span className={`rem-pill ${policy.enabled ? "is-on" : "is-muted"}`}>{dirty ? "修改待保存" : policy.enabled ? "自动推送已开启" : "自动推送已关闭"}</span>
      <button type="button" className="rem-button rem-button-primary" disabled={pending || !dirty} onClick={() => start(async () => { try { const result = await saveReminderPushPolicyAction(policy); setMessage(result.ok ? { tone: "ok", text: "推送设置已保存。" } : { tone: "error", text: result.error }); } catch { setMessage({ tone: "error", text: "保存失败，请重试" }); } })}>{pending ? "保存中…" : "保存推送设置"}</button>
      {message && <span role="status" className={`rem-feedback is-${message.tone}`}>{message.text}</span>}
    </div>
  </section>;
}
