import { getDB, schedules, queryWindows, defaultAlerts, windowText, overnight } from "@/modules/stocks/store";
import { nextFireForSchedule, nextWindowOccurrence } from "@/modules/stocks/next-fire";
import { timezoneValue } from "@/modules/stocks/windows";
import { displayClock } from "@/modules/stocks/tz";
import { scheduleAddAction, scheduleUpdateAction, zoneAction, windowSaveAction, windowDefaultAction, windowToggleAction, windowDeleteAction } from "../settings-actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "自动查询 · TickerSentry" };

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const db = getDB();
  const tz = timezoneValue(db);
  const list = schedules(db);
  for (const s of list) {
    if (s.enabled) {
      const t = nextFireForSchedule(s.hour, s.minute, tz, new Date());
      s.next = t ? displayClock(t, tz) : "";
    }
  }
  const windows = queryWindows(db);
  const defAlerts = defaultAlerts(db);
  const flashMap: Record<string, string> = {
    schedule_added: "查询时间点已添加。",
    schedule_saved: "查询时间点已更新。",
    schedule_enabled: "查询时间点已启用。",
    schedule_disabled: "查询时间点已暂停。",
    schedule_deleted: "查询时间点已删除。",
    zone_saved: "显示时区已保存。",
    window_saved: "查询时段已保存。",
    window_deleted: "查询时段已删除。",
    window_enabled: "查询时段已启用。",
    window_disabled: "查询时段已暂停。",
    default_saved: "每档默认提醒上限已更新。",
  };
  const notice = sp.error ?? flashMap[sp.flash ?? ""] ?? "";
  const pad = (n: number): string => String(n).padStart(2, "0");

  return (
    <div>
      {notice ? <p className="info-strip" role="status">{notice}</p> : null}
      <div className="page-head">
        <div><h1>自动查询</h1><p>设置时间段按间隔查询，也可以保留固定时间点。离线错过的查询不会补跑。</p></div>
      </div>
      <div className="info-strip page-notice">仅在 NYSE 常规交易时段查询；休市、日历超出核验窗口、任务繁忙或未配置 Key 时会记录跳过。有效报价命中提醒价格后发送到所有启用渠道；一只股票的所有启用档位额度都用尽后，停止该股票本时段的自动查询。</div>

      <div className="settings-grid schedule-controls">
        <section className="card">
          <h2>显示与执行时区</h2>
          <p className="muted">所有时间点共用同一时区，夏令时由系统自动处理。</p>
          <form action={zoneAction}>
            <label>时区
              <select name="timezone" defaultValue={tz}>
                <option value="Asia/Shanghai">Asia/Shanghai · 北京时间</option>
                <option value="America/New_York">America/New_York · 美东时间</option>
              </select>
            </label>
            <button type="submit">保存时区</button>
          </form>
        </section>
        <section className="card">
          <h2>添加查询时间</h2>
          <p className="muted">使用 {tz} 的 24 小时制时间。</p>
          <form action={scheduleAddAction}>
            <label>每天执行时间<input type="time" name="time" required /></label>
            <button type="submit">添加时间</button>
          </form>
        </section>
      </div>

      <section className="card">
        <h2>时间段查询</h2>
        <p>按 {tz} 执行。结束时间早于开始时间表示跨到次日；结束时刻不再查询。下一时段自动恢复查询。</p>
        <form action={windowDefaultAction} className="default-limit-form">
          <label>所有时段的每档默认提醒上限（次）<input type="number" name="max_alerts" min={1} max={1000} defaultValue={defAlerts} required /></label>
          <button type="submit">统一调整默认上限</button>
        </form>
        <p className="muted small">保存后同步更新所有已有时段，新建时段也使用此值；单个档位自行设置的上限不受影响，已提醒次数不会清零。</p>
        <form action={windowSaveAction} className="window-form">
          <input type="hidden" name="action" value="save" />
          <label>开始时间<input type="time" name="start" required /></label>
          <label>结束时间<input type="time" name="end" required /></label>
          <label>查询间隔（分钟）<input type="number" name="interval" min={1} max={1439} defaultValue={5} required /></label>
          <label>该时段每档默认上限（次）<input type="number" name="max_alerts" min={1} max={1000} defaultValue={defAlerts} required /></label>
          <button type="submit">添加查询时段</button>
        </form>
        <p className="muted small">可在股票详情为各档单独设置上限。每个方向每次只选一个最近命中档位；买入与卖出同时命中时每档只计一次。任一渠道成功或发送结果不确定占用次数，全部明确失败不占用。手动查询也遵守当前时段的档位上限。</p>
      </section>

      <section className="card">
        <h2>已配置的查询时段</h2>
        {windows.length === 0 ? (
          <p className="empty-state">还没有查询时段。在上方设置起止时间、间隔和各档默认上限即可开始。</p>
        ) : (
          windows.map((w) => (
            <article className="schedule-item" key={w.id}>
              <div className="schedule-item-head">
                <strong>{windowText(w.start)} ～ {overnight(w) ? "次日 " : ""}{windowText(w.end)}</strong>
                <span>{w.enabled ? "已启用" : "已暂停"}</span>
              </div>
              <p><strong>每 {w.interval} 分钟查询 · 每档默认最多提醒 {w.max_alerts} 次</strong></p>
              <details>
                <summary>修改查询时段</summary>
                <form action={windowSaveAction} className="window-form">
                  <input type="hidden" name="id" value={w.id} />
                  <input type="hidden" name="action" value="save" />
                  <label>开始时间<input type="time" name="start" defaultValue={windowText(w.start)} required /></label>
                  <label>结束时间<input type="time" name="end" defaultValue={windowText(w.end)} required /></label>
                  <label>间隔（分钟）<input type="number" name="interval" min={1} max={1439} defaultValue={w.interval} required /></label>
                  <label>该时段每档默认上限<input type="number" name="max_alerts" min={1} max={1000} defaultValue={w.max_alerts} required /></label>
                  <button type="submit">保存修改</button>
                </form>
              </details>
              <div className="schedule-actions">
                <form action={windowToggleAction}>
                  <input type="hidden" name="id" value={w.id} />
                  <input type="hidden" name="toggle" value={w.enabled ? "disable" : "enable"} />
                  <button type="submit">{w.enabled ? "暂停时段查询" : "恢复时段查询"}</button>
                </form>
                <form action={windowDeleteAction}>
                  <input type="hidden" name="id" value={w.id} />
                  <button className="delete-button" type="submit">删除</button>
                </form>
              </div>
            </article>
          ))
        )}
        <p className="muted small">时段不能重叠。时段内可调整间隔、提醒上限或暂停/恢复，次数不会清零；修改起止时间、删除和切换时区请在时段结束后操作。暂停不会清零次数。高频查询仍受行情接口额度限制，可在设置页查看预计用量。</p>
      </section>

      <section className="card schedule-list">
        <h2>已配置的时间</h2>
        <p className="muted">你可以修改、暂停或删除任一时间点。</p>
        {list.length === 0 ? (
          <p className="empty-state">尚未设置自动查询时间。你仍可以在首页手动查询。</p>
        ) : (
          <div className="schedule-items">
            {list.map((s) => (
              <article className="schedule-item" key={s.id}>
                <div className="schedule-item-head">
                  <strong>{pad(s.hour)}:{pad(s.minute)}</strong>
                  <span>{s.enabled ? "已启用" : "已暂停"}</span>
                </div>
                <p className="muted small">{s.next ? `下次执行：${s.next}` : "已暂停自动查询"}</p>
                <div className="schedule-actions">
                  <form action={scheduleUpdateAction} className="schedule-edit">
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="action" value="time" />
                    <label>修改时间<input type="time" name="time" defaultValue={`${pad(s.hour)}:${pad(s.minute)}`} required /></label>
                    <button type="submit">保存时间</button>
                  </form>
                  <form action={scheduleUpdateAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="action" value={s.enabled ? "disable" : "enable"} />
                    <button type="submit">{s.enabled ? "暂停查询" : "启用查询"}</button>
                  </form>
                  <form action={scheduleUpdateAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="action" value="delete" />
                    <button className="delete-button" type="submit">删除时间</button>
                  </form>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
