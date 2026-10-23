import Link from "next/link";

// 原版 respondError 的错误卡片页（templates/error.html + error-card 样式）。
// Server Action 找不到记录等场景 redirect 到这里。
export default async function StockErrorPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const is404 = code === "404";
  const title = is404 ? "找不到这个页面" : "操作未完成";
  const message = is404
    ? "页面或记录不存在，可能已被删除。"
    : "操作失败，请返回监控概览后重试。";

  return (
    <section className="card error-card" aria-labelledby="error-title">
      <span className="error-code">{code}</span>
      <h1 id="error-title">{title}</h1>
      <p className="error-message" role="alert">{message}</p>
      <p className="muted">返回上一页检查后再试，或回到监控概览继续操作。</p>
      <div className="error-actions">
        <a className="error-primary" href="/stocks">回到监控概览</a>
        <a href="/">工具箱</a>
      </div>
    </section>
  );
}
