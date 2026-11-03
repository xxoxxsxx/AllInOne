"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import type { ModulePolicy } from "@/lib/channels/module-policy";
import { saveReminderPushPolicyAction } from "./actions";

export function ReminderPushSettings({ initial }: { initial: ModulePolicy }) {
  const [policy, setPolicy] = useState(initial);
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const toggle = (key: keyof ModulePolicy, checked: boolean) => setPolicy(p => ({ ...p, [key]: checked }));
  return <section className="rem-push-settings" aria-label="提醒事项推送设置">
    <div><h2>提醒事项推送设置</h2><p>此开关仅控制提醒事项的自动推送，单条提醒仍可单独暂停。关闭期间保留计划，重新开启后按错过规则处理。</p></div>
    <label><input type="checkbox" checked={policy.enabled} onChange={e => toggle("enabled", e.target.checked)} /> 启用本模块自动推送</label>
    <fieldset><legend>本模块使用的渠道</legend>{([["bark", "Bark"], ["feishu", "飞书"], ["telegram", "Telegram"]] as const).map(([key, name]) => <label key={key}><input type="checkbox" checked={policy[key]} onChange={e => toggle(key, e.target.checked)} /> {name}</label>)}</fieldset>
    <p>渠道还需要在<Link href="/channels">全局推送渠道</Link>中配置并启用；手动测试不受自动开关影响。</p>
    <button type="button" className="rem-button rem-button-secondary" disabled={pending} onClick={() => start(async () => { try { const result = await saveReminderPushPolicyAction(policy); setMessage(result.ok ? "推送设置已保存" : result.error); } catch { setMessage("保存失败，请重试"); } })}>{pending ? "保存中…" : "保存推送设置"}</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
