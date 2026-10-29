import Link from "next/link";

import { getAmapKey, getTravelDB } from "@/lib/travel/db";

import { AmapSettingsForm } from "../settings-form";
import "./settings.css";

export const dynamic = "force-dynamic";

export const metadata = { title: "旅行攻略 · 搜索设置" };

export default function TravelSettingsPage() {
  // 服务器读取 Key 但只下发「是否已配置」，完整值不进入客户端。
  let configured = false;
  try {
    configured = getAmapKey(getTravelDB()).trim().length > 0;
  } catch {
    configured = false;
  }

  return (
    <main className="travel-page">
      <div className="travel-container">
        <Link href="/travel" className="travel-back">← 返回行程</Link>
        <header className="travel-hero">
          <p className="travel-kicker">Travel Settings</p>
          <h1 className="travel-title">地点搜索设置</h1>
          <p className="travel-sub">配置高德 Web 服务 Key 后，行程页可搜索景点并直接加入行程。</p>
        </header>
        <section className="travel-settings-card">
          <h2>高德 Web 服务 Key</h2>
          <p>
            {configured
              ? "当前状态：已配置。输入新的 Key 并保存即可替换；删除后行程页的搜索框会停用。"
              : "当前状态：未配置。行程页暂无搜索框，地图点选不受影响。"}
          </p>
          <AmapSettingsForm configured={configured} />
        </section>
      </div>
    </main>
  );
}
