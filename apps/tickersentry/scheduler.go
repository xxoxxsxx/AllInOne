package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Schedule struct {
	ID           int64
	Hour, Minute int
	Enabled      bool
	Next         string
}

func schedules(db *sql.DB) ([]Schedule, error) {
	rows, err := db.Query(`SELECT id,hour,minute,enabled FROM schedules ORDER BY hour,minute`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Schedule{}
	for rows.Next() {
		var s Schedule
		if err := rows.Scan(&s.ID, &s.Hour, &s.Minute, &s.Enabled); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
func zone(db *sql.DB) (string, *time.Location, error) {
	name, err := value(db, `SELECT timezone FROM settings WHERE id=1`)
	if err != nil {
		return "", nil, err
	}
	loc, err := time.LoadLocation(name)
	return name, loc, err
}
func nextFire(s Schedule, loc *time.Location, after time.Time) time.Time {
	local := after.In(loc)
	for i := 0; i < 370; i++ {
		day := local.AddDate(0, 0, i)
		t := time.Date(day.Year(), day.Month(), day.Day(), s.Hour, s.Minute, 0, 0, loc)
		// A nonexistent wall-clock time during a DST transition is skipped.
		if t.In(loc).Hour() == s.Hour && t.In(loc).Minute() == s.Minute && t.After(after) {
			return t
		}
	}
	return time.Time{}
}
func (a *App) schedulePage(w http.ResponseWriter, r *http.Request) {
	list, err := schedules(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	name, loc, err := zone(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	for i := range list {
		if list[i].Enabled {
			list[i].Next = nextFire(list[i], loc, time.Now()).Format(time.RFC3339)
		}
	}
	windows, err := queryWindows(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var defaultAlerts int
	if err := a.db.QueryRow(`SELECT default_alerts FROM settings WHERE id=1`).Scan(&defaultAlerts); err != nil {
		a.fail(w, r, err)
		return
	}
	a.renderApp(w, "schedule", view{Notice: flashNotice(r), Windows: windows, Title: "查询时间", CSRF: a.csrf, Schedules: list, Timezone: name, DefaultAlerts: defaultAlerts})
}
func parseClock(text string) (time.Time, error) {
	t, err := time.Parse("15:04", text)
	if err != nil || t.Format("15:04") != text {
		return time.Time{}, fmt.Errorf("时间必须为 HH:MM")
	}
	return t, nil
}
func (a *App) scheduleAdd(w http.ResponseWriter, r *http.Request) {
	text := r.PostForm.Get("time")
	t, err := parseClock(text)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	if _, err = a.db.Exec(`INSERT INTO schedules(hour,minute) VALUES(?,?)`, t.Hour(), t.Minute()); err != nil {
		a.formError(w, r, "时间已存在或存储失败")
		return
	}
	http.Redirect(w, r, a.href("/schedule?flash=schedule_added"), 303)
}
func (a *App) scheduleUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	action := r.PathValue("action")
	var res sql.Result
	var flash string
	switch action {
	case "time":
		flash = "schedule_saved"
		var t time.Time
		t, err = parseClock(r.PostForm.Get("time"))
		if err != nil {
			a.formError(w, r, err.Error())
			return
		}
		res, err = a.db.Exec(`UPDATE schedules SET hour=?,minute=? WHERE id=?`, t.Hour(), t.Minute(), id)
	case "enable":
		flash = "schedule_enabled"
		res, err = a.db.Exec(`UPDATE schedules SET enabled=1 WHERE id=?`, id)
	case "disable":
		flash = "schedule_disabled"
		res, err = a.db.Exec(`UPDATE schedules SET enabled=0 WHERE id=?`, id)
	case "delete":
		flash = "schedule_deleted"
		res, err = a.db.Exec(`DELETE FROM schedules WHERE id=?`, id)
	default:
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
		return
	}
	if err != nil {
		if action == "time" {
			a.formError(w, r, "时间已存在或存储失败")
			return
		}
		a.fail(w, r, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
		return
	}
	http.Redirect(w, r, a.href("/schedule?flash="+flash), 303)
}
func (a *App) zonePost(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	name := r.PostForm.Get("timezone")
	current, _, err := zone(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if name != current {
		active, _, err := a.activeWindow(time.Now())
		if err != nil {
			a.fail(w, r, err)
			return
		}
		if active != nil {
			a.formError(w, r, "当前处于查询时段内，请在时段结束后修改时区。")
			return
		}
	}
	if name != "Asia/Shanghai" && name != "America/New_York" {
		a.formError(w, r, "不支持该时区")
		return
	}
	if _, err := a.db.Exec(`UPDATE settings SET timezone=? WHERE id=1`, name); err != nil {
		a.fail(w, r, err)
		return
	}
	http.Redirect(w, r, a.href("/schedule?flash=zone_saved"), 303)
}
func (a *App) scheduleLoop() {
	defer a.jobs.Done()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	cleanup := time.NewTicker(24 * time.Hour)
	defer cleanup.Stop()
	// Never replay the minute during which the process started or was restarted.
	last := time.Now().Truncate(time.Minute)
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-cleanup.C:
			if err := pruneHistory(a.db, time.Now().UTC()); err != nil {
				log.Printf("history cleanup: %v", err)
			}
		case now := <-ticker.C:
			minute := now.Truncate(time.Minute)
			if !minute.After(last) {
				continue
			}
			elapsed := minute.Sub(last)
			last = minute
			if elapsed != time.Minute {
				continue
			} // sleep/offline minutes are not caught up
			a.fireSchedules(minute)
		}
	}
}
func (a *App) fireSchedules(at time.Time) {
	list, err := schedules(a.db)
	if err != nil {
		log.Printf("schedule read: %v", err)
		return
	}
	_, loc, err := zone(a.db)
	if err != nil {
		log.Printf("schedule timezone: %v", err)
		return
	}
	local := at.In(loc)
	windows, err := queryWindows(a.db)
	if err != nil {
		log.Printf("query windows: %v", err)
		return
	}
	for _, w := range windows {
		if _, offset, active := w.occurrence(at, loc); w.Enabled && active && offset%w.Interval == 0 {
			a.scheduled(0, at, local.Format("2006-01-02T15:04"))
		}
	}
	for _, s := range list {
		if s.Enabled && s.Hour == local.Hour() && s.Minute == local.Minute() {
			a.scheduled(s.ID, at, local.Format("2006-01-02T15:04"))
		}
	}
}
func (a *App) scheduled(scheduleID int64, at time.Time, slot string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var seen int
	if err := a.db.QueryRow(`SELECT count(*) FROM runs WHERE kind='scheduled' AND slot=?`, slot).Scan(&seen); err != nil {
		log.Printf("schedule dedupe: %v", err)
		return
	}
	if seen > 0 {
		return
	} // duplicated local wall time during autumn DST rollback
	reason := ""
	switch {
	case !calendarReviewed(at):
		reason = "交易日历超出已核验年份"
	case !nyse.IsOpen(at):
		reason = "市场休市或不在常规交易时段"
	case a.runningID != 0:
		reason = "上一轮查询仍在运行"
	}
	key, err := value(a.db, `SELECT api_key FROM settings WHERE id=1`)
	if err != nil {
		log.Printf("schedule settings: %v", err)
		return
	}
	if reason == "" && strings.TrimSpace(key) == "" {
		reason = "未配置 Twelve Data Key"
	}
	proxy, err := proxySetting(a.db)
	if err != nil {
		log.Printf("schedule proxy settings: %v", err)
		return
	}
	all, err := listStocks(a.db)
	if err != nil {
		log.Printf("schedule stocks: %v", err)
		return
	}
	active := []Stock{}
	for _, s := range all {
		if s.Enabled {
			_, capped, err := a.windowStatus(s.ID, s.Symbol, at)
			if err != nil {
				log.Printf("window quota: %v", err)
				return
			}
			if capped {
				continue
			}
			active = append(active, s)
		}
	}
	if reason == "" && len(active) == 0 {
		reason = "没有可查询的股票（未启用或本时段所有档位额度已用尽）"
	}
	due := slot
	slotAt := at.UTC().Format(time.RFC3339Nano)
	if reason != "" {
		if _, err := a.db.Exec(`INSERT OR IGNORE INTO runs(kind,started_at,finished_at,status,reason,schedule_id,slot,slot_at) VALUES('scheduled',?,?, 'skipped',?,?,?,?)`, now(), now(), reason, scheduleID, due, slotAt); err != nil {
			log.Printf("schedule skip: %v", err)
		}
		return
	}
	id, err := createRun(a.db, active, "scheduled", scheduleID, due, slotAt)
	if err != nil {
		log.Printf("schedule create: %v", err)
		return
	}
	a.runningID = id
	a.jobs.Add(1)
	go a.runOnce(id, active, newTwelveData(key, proxy))
}

// Reserve a Twelve Data call before sending it, across manual and scheduled runs.
// The conservative free-plan budget is eight requests per rolling minute and 800 per 24h.
func (a *App) reserve(ctx context.Context) error {
	for {
		t := time.Now().UTC()
		tx, err := a.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM quote_calls WHERE at<?`, quotaAt(t.Add(-24*time.Hour)))
		var count, day int
		var oldest string
		if err == nil {
			err = tx.QueryRowContext(ctx, `SELECT count(*),COALESCE(MIN(at),'') FROM quote_calls WHERE at>?`, quotaAt(t.Add(-time.Minute))).Scan(&count, &oldest)
		}
		if err == nil {
			err = tx.QueryRowContext(ctx, `SELECT count(*) FROM quote_calls`).Scan(&day)
		}
		if err != nil {
			tx.Rollback()
			return err
		}
		if day >= 800 {
			tx.Rollback()
			return errors.New("行情接口 24 小时额度已用尽")
		}
		if count < 8 {
			_, err = tx.ExecContext(ctx, `INSERT INTO quote_calls(at) VALUES(?)`, quotaAt(t))
			if err != nil {
				tx.Rollback()
				return err
			}
			return tx.Commit()
		}
		tx.Rollback()
		first, err := time.Parse(time.RFC3339Nano, oldest)
		if err != nil {
			return err
		}
		delay := time.Until(first.Add(time.Minute).Add(time.Second))
		if delay < time.Second {
			delay = time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
func waitRetry(ctx context.Context, d time.Duration) error {
	if d <= 0 || d > 2*time.Minute {
		return fmt.Errorf("行情服务限流 (429)，未给出可用的短期重试时间")
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
func retryDelay(value string) time.Duration {
	if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	if t, err := http.ParseTime(value); err == nil {
		return time.Until(t)
	}
	return 0
}

func quotaAt(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }
