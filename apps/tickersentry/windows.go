package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// A window repeats every day in the configured timezone. End is exclusive.
type QueryWindow struct {
	ID                              int64
	Start, End, Interval, MaxAlerts int
	Enabled                         bool
}

func (w QueryWindow) StartText() string { return fmt.Sprintf("%02d:%02d", w.Start/60, w.Start%60) }
func (w QueryWindow) EndText() string   { return fmt.Sprintf("%02d:%02d", w.End/60, w.End%60) }
func (w QueryWindow) Overnight() bool   { return w.End < w.Start }
func (w QueryWindow) duration() int     { return (w.End - w.Start + 1440) % 1440 }
func (w QueryWindow) occurrence(at time.Time, loc *time.Location) (string, int, bool) {
	t := at.In(loc)
	minute := t.Hour()*60 + t.Minute()
	offset := (minute - w.Start + 1440) % 1440
	if offset >= w.duration() {
		return "", 0, false
	}
	if minute < w.Start {
		t = t.AddDate(0, 0, -1)
	}
	return t.Format("2006-01-02"), offset, true
}
func queryWindows(db *sql.DB) ([]QueryWindow, error) {
	rows, err := db.Query(`SELECT id,start,end,interval,max_alerts,enabled FROM query_windows ORDER BY start`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []QueryWindow{}
	for rows.Next() {
		var w QueryWindow
		if err = rows.Scan(&w.ID, &w.Start, &w.End, &w.Interval, &w.MaxAlerts, &w.Enabled); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}
func validWindow(w QueryWindow) bool {
	return w.Start >= 0 && w.Start < 1440 && w.End >= 0 && w.End < 1440 && w.Start != w.End && w.Interval >= 1 && w.Interval <= w.duration() && w.MaxAlerts >= 1 && w.MaxAlerts <= 1000
}
func (a *App) windowDefault(w http.ResponseWriter, r *http.Request) {
	limit, err := strconv.Atoi(r.PostForm.Get("max_alerts"))
	if err != nil || limit < 1 || limit > 1000 {
		a.formError(w, r, "每档默认提醒上限须为 1～1000 次。")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, err := a.db.Begin()
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE settings SET default_alerts=? WHERE id=1`, limit); err == nil {
		_, err = tx.Exec(`UPDATE query_windows SET max_alerts=?`, limit)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	http.Redirect(w, r, a.href("/schedule?flash=default_saved"), http.StatusSeeOther)
}
func windowsOverlap(a, b QueryWindow) bool {
	return (b.Start-a.Start+1440)%1440 < a.duration() || (a.Start-b.Start+1440)%1440 < b.duration()
}
func (a *App) windowSave(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	list, err := queryWindows(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var id int64
	if r.PathValue("id") != "" {
		id, err = pathID(r)
		if err != nil {
			a.formError(w, r, err.Error())
			return
		}
	}
	_, loc, err := zone(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	found := id == 0
	var previous *QueryWindow
	for _, item := range list {
		if item.ID == id {
			found = true
			previous = &item
			if _, _, active := item.occurrence(time.Now(), loc); active && r.PathValue("action") == "delete" {
				a.formError(w, r, "当前处于此时间段内，可暂停查询；请在时段结束后删除，避免重置档位提醒额度。")
				return
			}
		}
	}
	if !found {
		a.respondError(w, r, 404, "查询时段不存在")
		return
	}
	var flash string
	switch r.PathValue("action") {
	case "delete":
		flash = "window_deleted"
		_, err = a.db.Exec(`DELETE FROM query_windows WHERE id=?`, id)
	case "disable", "enable":
		flash = "window_disabled"
		if r.PathValue("action") == "enable" {
			flash = "window_enabled"
		}
		_, err = a.db.Exec(`UPDATE query_windows SET enabled=? WHERE id=?`, r.PathValue("action") == "enable", id)
	case "", "save":
		flash = "window_saved"
		start, e1 := parseClock(r.PostForm.Get("start"))
		end, e2 := parseClock(r.PostForm.Get("end"))
		interval, e3 := strconv.Atoi(r.PostForm.Get("interval"))
		limit, e4 := strconv.Atoi(r.PostForm.Get("max_alerts"))
		item := QueryWindow{ID: id, Start: start.Hour()*60 + start.Minute(), End: end.Hour()*60 + end.Minute(), Interval: interval, MaxAlerts: limit}
		if e1 != nil || e2 != nil || e3 != nil || e4 != nil || !validWindow(item) {
			a.formError(w, r, "开始与结束时间须不同，间隔为 1 分钟至时段长度，每档默认提醒上限为 1～1000 次。")
			return
		}
		if previous != nil {
			if _, _, active := previous.occurrence(time.Now(), loc); active && (item.Start != previous.Start || item.End != previous.End) {
				a.formError(w, r, "当前时段可修改间隔和提醒上限；起止时间请在时段结束后修改。")
				return
			}
		}
		for _, other := range list {
			if other.ID != id && windowsOverlap(item, other) {
				a.formError(w, r, "查询时段不能重叠（包括已暂停的时段）。")
				return
			}
		}
		if id == 0 {
			_, err = a.db.Exec(`INSERT INTO query_windows(start,end,interval,max_alerts) VALUES(?,?,?,?)`, item.Start, item.End, item.Interval, item.MaxAlerts)
		} else {
			_, err = a.db.Exec(`UPDATE query_windows SET start=?,end=?,interval=?,max_alerts=? WHERE id=?`, item.Start, item.End, item.Interval, item.MaxAlerts, id)
		}
	default:
		a.respondError(w, r, 404, "操作不存在")
		return
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	http.Redirect(w, r, a.href("/schedule?flash="+flash), 303)
}

// Pausing queries does not remove the notification cap for manual queries.
func (a *App) activeWindow(at time.Time) (*QueryWindow, string, error) {
	list, err := queryWindows(a.db)
	if err != nil {
		return nil, "", err
	}
	_, loc, err := zone(a.db)
	if err != nil {
		return nil, "", err
	}
	for _, w := range list {
		if day, _, active := w.occurrence(at, loc); active {
			return &w, day, nil
		}
	}
	return nil, "", nil
}
func (a *App) windowUsage(w *QueryWindow, day, symbol string) (map[string]int, error) {
	rows, err := a.db.Query(`SELECT json_extract(j.value,'$.uid'),count(*) FROM notifications n, json_each(n.levels) j
		WHERE n.window_id=? AND n.window_day=? AND n.symbol=? AND n.status IN ('发送中','成功','部分成功','不确定')
		GROUP BY json_extract(j.value,'$.uid')`, w.ID, day, symbol)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	usage := map[string]int{}
	for rows.Next() {
		var uid sql.NullString
		var count int
		if err := rows.Scan(&uid, &count); err != nil {
			return nil, err
		}
		if uid.Valid {
			usage[uid.String] = count
		}
	}
	return usage, rows.Err()
}
func (a *App) windowUsageAll(w *QueryWindow, day string) (map[string]map[string]int, error) {
	rows, err := a.db.Query(`SELECT n.symbol,json_extract(j.value,'$.uid'),count(*) FROM notifications n, json_each(n.levels) j
		WHERE n.window_id=? AND n.window_day=? AND n.status IN ('发送中','成功','部分成功','不确定')
		GROUP BY n.symbol,json_extract(j.value,'$.uid')`, w.ID, day)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	usage := map[string]map[string]int{}
	for rows.Next() {
		var symbol string
		var uid sql.NullString
		var count int
		if err := rows.Scan(&symbol, &uid, &count); err != nil {
			return nil, err
		}
		if uid.Valid {
			if usage[symbol] == nil {
				usage[symbol] = map[string]int{}
			}
			usage[symbol][uid.String] = count
		}
	}
	return usage, rows.Err()
}
func (a *App) levelUsage(stockID int64, symbol string, at time.Time) ([]Level, *QueryWindow, error) {
	levels, err := listLevels(a.db, stockID)
	if err != nil {
		return nil, nil, err
	}
	w, day, err := a.activeWindow(at)
	if err != nil || w == nil {
		return levels, w, err
	}
	usage, err := a.windowUsage(w, day, symbol)
	if err != nil {
		return nil, nil, err
	}
	for i := range levels {
		levels[i].Used = usage[levels[i].UID]
		levels[i].Limit = levels[i].alertLimit(w)
		levels[i].WindowActive = true
	}
	return levels, w, nil
}
func (a *App) windowStatus(stockID int64, symbol string, at time.Time) (string, bool, error) {
	levels, w, err := a.levelUsage(stockID, symbol, at)
	status, capped := windowSummary(levels, w)
	return status, capped, err
}
func windowSummary(levels []Level, w *QueryWindow) (string, bool) {
	if w == nil {
		return "", false
	}
	active, exhausted := 0, 0
	for _, l := range levels {
		if l.Enabled {
			active++
			if l.Used >= l.Limit {
				exhausted++
			}
		}
	}
	status := fmt.Sprintf("本时段档位额度：%d/%d 个已用尽", exhausted, active)
	if active > 0 && exhausted == active {
		return status + " · 本时段自动查询已停止", true
	}
	if !w.Enabled {
		return status + " · 时段查询已暂停", false
	}
	return status, false
}
func nextWindowFire(w QueryWindow, loc *time.Location, after time.Time) time.Time {
	// Walk real minutes so skipped and repeated DST wall times are handled consistently.
	for t, end := after.Truncate(time.Minute).Add(time.Minute), after.Add(49*time.Hour); t.Before(end); t = t.Add(time.Minute) {
		if _, offset, active := w.occurrence(t, loc); active && offset%w.Interval == 0 {
			return t
		}
	}
	return time.Time{}
}
