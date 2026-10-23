import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "我的工具箱",
  description: "个人工具聚合站点：业务管理、金融监控与图片创作工具的统一入口。",
};

// 首屏前设置主题，避免闪烁（PRD §5.7）。
const themeScript = `try{var t=localStorage.getItem('allinone:v1:theme');document.documentElement.dataset.theme=(t==='light'||t==='dark')?t:'system';}catch(e){document.documentElement.dataset.theme='system';}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-theme="system" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="site-brand">
              <span className="site-brand-mark" aria-hidden="true">
                ▦
              </span>
              我的工具箱
            </Link>
            <nav className="site-nav" aria-label="站点导航">
              <Link href="/">工具箱</Link>
              <Link href="/status">状态</Link>
              <Link href="/preferences">偏好</Link>
            </nav>
          </div>
        </header>
        <main className="site-main">{children}</main>
        <footer className="site-footer">
          <span>AllInOne · 个人工具聚合</span>
        </footer>
      </body>
    </html>
  );
}
