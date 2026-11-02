// Next.js 应用启动钩子：注册 TickerSentry 应用内调度器、证件到期提醒调度器与提醒事项调度器。
// 长驻进程（next start）下 register() 在服务启动时执行一次。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISABLE_SCHEDULER === "1") return;
  const { startStocksScheduler } = await import("./modules/stocks/scheduler");
  startStocksScheduler();
  // 证件到期提醒：每 10 分钟 tick 一次，由 runner 自行判断北京时间整点匹配与当日去重。
  // stocks 库或 documents 库不可用时不影响启动，tick 内部捕获所有异常并仅记录日志。
  try {
    const { startDocumentReminderScheduler } = await import("./lib/documents/reminders-run");
    startDocumentReminderScheduler();
  } catch (error) {
    console.error("证件到期提醒调度器启动失败", error);
  }
  // 提醒事项：每 30 秒 tick 一次（单次/间隔/cron 到期判定与补发语义见 lib/reminders）。
  // reminders 库或渠道配置不可用时不影响启动，tick 内部捕获所有异常并仅记录日志。
  try {
    const { startRemindersScheduler } = await import("./lib/reminders/run");
    startRemindersScheduler();
  } catch (error) {
    console.error("提醒事项调度器启动失败", error);
  }
}
