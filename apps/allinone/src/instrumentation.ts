// Next.js 应用启动钩子：注册 TickerSentry 应用内调度器。
// 长驻进程（next start）下 register() 在服务启动时执行一次。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISABLE_SCHEDULER === "1") return;
  const { startStocksScheduler } = await import("./modules/stocks/scheduler");
  startStocksScheduler();
}
