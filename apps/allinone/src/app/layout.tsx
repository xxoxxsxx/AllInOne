import type { Metadata } from "next";
import { Sidebar } from "@/components/sidebar";
import { loadCatalog } from "@/lib/tools";
import "./globals.css";
import "./portal.css";
import "./workbench.css";

export const metadata: Metadata = {
  title: "我的工具箱",
  description: "个人工具聚合站点：业务管理、金融监控与图片创作工具的统一入口。",
};

// 首屏前设置主题，避免闪烁（PRD §5.7）。
const themeScript = `try{var t=localStorage.getItem('allinone:v1:theme');document.documentElement.dataset.theme=(t==='light'||t==='dark')?t:'system';}catch(e){document.documentElement.dataset.theme='system';}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { tools, categories } = loadCatalog();
  return (
    <html lang="zh-CN" data-theme="system" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <div className="portal-shell">
          <Sidebar tools={tools} categories={categories} />
          <div className="portal-content">{children}</div>
        </div>
      </body>
    </html>
  );
}
