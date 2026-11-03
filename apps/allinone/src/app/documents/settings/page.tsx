import Link from "next/link";

import "./reminder-page.css";

import { getModulePolicy } from "@/lib/channels/module-policy";
import { todayStr } from "@/lib/documents/constants";
import { getDocumentsDB, listDocuments } from "@/lib/documents/db";
import { getReminderSettings, selectExpiringDocuments } from "@/lib/documents/reminders";
import { summarizeReminderChannels } from "@/lib/documents/reminders-channels";

import { RemindersSettings } from "./reminders-settings";

export const dynamic = "force-dynamic";

export const metadata = { title: "到期提醒设置 · 证件夹" };

// /documents/settings 路由页：服务端读取提醒设置、渠道摘要与到期证件后挂载设置面板。
// 本文件只负责页面壳（hero / 调度器警告 / 提醒速览 / 今日到期预览），样式在 ./reminder-page.css；
// 面板本体与表单在 ./reminders-settings.tsx（视觉由配套的 reminder-panel.css 负责）。

const PREVIEW_LIMIT = 10;

export default async function ReminderSettingsPage() {
  const db = getDocumentsDB();
  const settings = getReminderSettings(db);
  const dueDocs = selectExpiringDocuments(listDocuments(db, todayStr()));
  // 渠道摘要读取自全局推送渠道中心（@/lib/channels/center）；渠道表单在独立页面 /channels，
  // 面板保存证件夹自己的渠道选择，同时展示全局可用状态。
  const channels0 = summarizeReminderChannels(db);
  const schedulerDisabled = process.env.DISABLE_SCHEDULER === "1";

  // 调度语义（与 reminders-run.ts 一致）：tick 约每 10 分钟一次；北京时间小时等于设定小时才推送；
  // 部分成功/结果不确定也写当日标记（不重发），仅全部渠道明确失败才在当天内下一轮重试。
  // 尚未生效（startDate 在未来）但到期日已进入 30 天窗口的证件仍是 status=expiring，会被提醒。
  const facts: { title: string; body: string }[] = [
    {
      title: "何时推送",
      body: "调度器约每 10 分钟检查一次；北京时间到达设定的整点小时后，小时内的首次检查即推送当天提醒。",
    },
    {
      title: "不会重复打扰",
      body: "部分成功或结果不确定也记当日标记、避免重复推送，重启或重复检查都不会重发；全部渠道明确失败时，会在设定的小时内于下次检查（约 10 分钟后）重试。",
    },
    {
      title: "推送范围",
      body: "只把到期日在 30 天内（含今天到期）的证件合并为一条推送；已过期不在其中，尚未生效但到期日已进入窗口的也会提醒。当天没有到期证件则不推送。",
    },
  ];

  return (
    <main className="docs-page rpg-page">
      <Link href="/documents" className="rpg-back">
        <span className="rpg-back-arrow" aria-hidden="true">←</span>
        返回证件夹
      </Link>

      <header className="docs-hero">
        <p className="docs-kicker">Document Vault · Reminder</p>
        <h1 className="docs-title">到期提醒设置</h1>
        <p className="docs-sub">
          每天把 30 天内到期的证件合并成一条推送（Bark / 飞书 / Telegram），每天最多一次。
          当前状态见下方设置面板（保存后即时更新）。
        </p>
      </header>

      {schedulerDisabled ? (
        <div className="rpg-callout" role="status">
          <span className="rpg-callout-icon" aria-hidden="true">⚠</span>
          <p>
            内置调度器已禁用（DISABLE_SCHEDULER=1）：设置仍会保存，但提醒不会自动发送；如需自动推送请在部署环境移除该变量。
          </p>
        </div>
      ) : null}

      <RemindersSettings initialSettings={settings} initialChannels={channels0} initialSelection={getModulePolicy(db, "documents", true)} />

      <section className="rpg-card" aria-label="提醒速览">
        <div className="rpg-card-head">
          <h2>提醒速览</h2>
          <span className="rpg-card-note">开关、时刻与渠道都在上方面板里配置；这里说明它的工作方式。</span>
        </div>

        <p className="rpg-hint">
          Bark / 飞书 / Telegram 渠道在<Link href="/channels">全局推送渠道</Link>页统一配置（证件夹与提醒事项共用）；
          这里的「立即检查」与「发送测试」按已保存的证件夹渠道选择真实推送，均不受每日提醒开关限制。提醒开关与推送时间在上方设置面板。
        </p>

        <div className="rpg-facts">
          {facts.map((f) => (
            <div key={f.title} className="rpg-fact">
              <h3 className="rpg-fact-title">
                <span className="rpg-fact-k" aria-hidden="true" />
                {f.title}
              </h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
        <p className="rpg-hint">
          调度器随应用启动（next start）运行；DISABLE_SCHEDULER=1 时停用自动推送与行情自动查询，设置仍会保存。
        </p>
      </section>

      <section className="rpg-card" aria-label="今日提醒预览">
        <div className="rpg-card-head">
          <h2>今天会提醒的证件</h2>
          <span className="rpg-count">{dueDocs.length} 份</span>
          <span className="rpg-card-note">30 天内到期，按紧迫程度排序</span>
        </div>
        {dueDocs.length === 0 ? (
          <p className="rpg-empty">当前没有 30 天内到期的证件，到点不会推送。</p>
        ) : (
          <>
            <ul className="rpg-due-list">
              {dueDocs.slice(0, PREVIEW_LIMIT).map((d) => (
                <li key={d.id} className="rpg-due-item">
                  <span className="rpg-due-title">{d.title}</span>
                  <span className="rpg-due-meta">
                    {d.expiryDate}
                    {d.holderName ? ` · ${d.holderName}` : ""}
                  </span>
                  <span className={`rpg-badge ${d.daysLeft === 0 ? "rpg-badge-today" : "rpg-badge-soon"}`}>
                    {d.daysLeft === 0 ? "今天到期" : `还剩 ${d.daysLeft} 天`}
                  </span>
                </li>
              ))}
            </ul>
            {dueDocs.length > PREVIEW_LIMIT ? (
              <p className="rpg-due-more">……等共 {dueDocs.length} 份；实际推送会按持有人分组列出。</p>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
