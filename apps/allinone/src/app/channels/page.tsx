import Link from "next/link";

import "./channels.css";
import "../documents/settings/reminder-panel.css";

import { getChannelConfig, summarizeChannels } from "@/lib/channels/center";

import { ChannelCenterForm } from "./channel-center-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "全局推送渠道 · AllInOne" };

// /channels 全局推送渠道：证件夹到期提醒与提醒事项共用的唯一渠道配置入口。
// 页面壳只做服务端摘要展示，表单状态由客户端组件在保存后实时同步（避免页面快照过期）。

export default async function ChannelsPage() {
  const config = getChannelConfig();
  const channels = summarizeChannels(config);

  return (
    <main className="channels-page">
      <Link href="/" className="channels-back">← 工具箱</Link>

      <header className="channels-hero ui-heading ui-heading-stack">
        <p className="channels-kicker ui-kicker">GLOBAL PUSH CHANNELS</p>
        <h1 className="channels-title">全局推送渠道</h1>
        <p className="channels-sub ui-subtitle">
          证件夹到期提醒与提醒事项共用这份 Bark / 飞书 / Telegram 配置，改一处全局生效。
          保存后可用各渠道的「测试」按钮核对送达。
        </p>
      </header>

      <div className="ui-split channel-workspace">
        <ChannelCenterForm initialChannels={channels} initialConfig={config} />
        <nav className="ui-rail" aria-label="跳转到推送渠道">
          <div className="ui-panel">
            <h2>渠道导航</h2>
            <ul className="ui-summary-list">
              <li><a href="#channel-bark">Bark</a></li>
              <li><a href="#channel-feishu">飞书</a></li>
              <li><a href="#channel-telegram">Telegram</a></li>
            </ul>
          </div>
        </nav>
      </div>

      <p className="channels-note">
        提醒开关与推送时间等业务设置在各工具内配置：证件夹见「到期提醒设置」，提醒事项见对应提醒的编辑面板。
      </p>
    </main>
  );
}
