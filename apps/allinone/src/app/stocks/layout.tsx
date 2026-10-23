import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { StocksBehaviors, StocksNav } from "./stocks-client";

// 原版 TickerSentry static/app.css 逐字节复用（不改任何规则）；shell.css 先于它加载，
// 只负责停用根布局的门户 chrome（根布局与 globals.css 不在本次可修改范围内），
// 使本段的 header/main/footer 成为页面唯一外壳。
import "./shell.css";
import "@/modules/stocks/stocks.css";

// favicon：原版 /static/favicon.svg → public/stocks-assets/favicon.svg（head 规格同 common.html）。
export const metadata: Metadata = {
  icons: [{ rel: "icon", url: "/stocks-assets/favicon.svg", type: "image/svg+xml", sizes: "any" }],
};

// common.html <meta name="theme-color" content="#142d33">。
export const viewport: Viewport = {
  themeColor: "#142d33",
};

// common.html 骨架：site-header（品牌 + 主导航）/ site-main / site-footer。
// 导航在原版三项之前加「工具箱」→ /（聚合站点公共导航，PRD §8/§5.5 的统一约定）。
export default function StocksLayout({ children }: { children: ReactNode }) {
  return (
    <div className="ts-shell">
      <header className="site-header">
        <div className="header-inner">
          <Link className="brand" href="/stocks" aria-label="TickerSentry 首页">
            <span className="brand-mark" aria-hidden="true">T</span>
            <span>
              Ticker<span className="brand-accent">Sentry</span>
              <small>美股价哨</small>
            </span>
          </Link>
          <StocksNav />
        </div>
      </header>
      <main className="site-main">{children}</main>
      <footer className="site-footer">
        <span>TickerSentry · 带 Key 预览版</span>
        <span>报价为离散快照，仅供提醒，不构成交易建议</span>
      </footer>
      <StocksBehaviors />
    </div>
  );
}
