package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/shopspring/decimal"
	_ "modernc.org/sqlite"
)

type Stock struct {
	WindowCapped bool
	ReferenceBuy string
	BuyBasis     string
	ID           int64
	Symbol       string
	Note         string
	Enabled      bool
	LastPrice    string
	Open         string
	PrevClose    string
	DayChange    string
	DayPercent   string
	DayClass     string
	LastAt       string
	LastSource   string
	LastStatus   string
	LastError    string
	TimeField    string
	AssetOK      bool
	AlertReason  string
	WindowStatus string
	BuyLevels    []Level
	SellLevels   []Level
}

type Run struct {
	Kind       string   `json:"kind"`
	Done       int      `json:"done"`
	Total      int      `json:"total"`
	ID         int64    `json:"id"`
	Status     string   `json:"status"`
	Reason     string   `json:"reason"`
	StartedAt  string   `json:"started_at"`
	SlotAt     string   `json:"slot_at"`
	FinishedAt string   `json:"finished_at"`
	Results    []Result `json:"results"`
}

type Result struct {
	AssetOK     bool   `json:"asset_ok"`
	Symbol      string `json:"symbol"`
	Price       string `json:"price"`
	Open        string `json:"open"`
	PrevClose   string `json:"previous_close"`
	QuoteAt     string `json:"quote_at"`
	FetchedAt   string `json:"fetched_at"`
	Source      string `json:"source"`
	TimeField   string `json:"time_field"`
	Delay       string `json:"delay"`
	Status      string `json:"status"`
	Error       string `json:"error"`
	AlertStatus string `json:"alert_status"`
}

type StockQuote struct {
	Open        string
	PrevClose   string
	RunID       int64
	Price       string
	QuoteAt     string
	FetchedAt   string
	Source      string
	Status      string
	Error       string
	AlertStatus string
}

func openDB(dir string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", filepath.Join(dir, "ticker.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	for _, p := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=5000"} {
		if _, err = db.Exec(p); err != nil {
			db.Close()
			return nil, err
		}
	}
	if err = migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	_, err = db.Exec(`UPDATE runs SET status='interrupted', reason='进程中断，旧报价不会补查', finished_at=? WHERE status='running'`, now())
	if err == nil {
		_, err = db.Exec(`UPDATE results SET status='interrupted', error='进程中断' WHERE status='pending'`)
	}
	if err == nil {
	}
	if err == nil {
		_, err = db.Exec(`UPDATE notification_channels SET status='不确定',error='进程中断，发送结果未知' WHERE status='发送中'`)
	}
	if err == nil {
		_, err = db.Exec(`UPDATE notification_channels SET status='未发送' WHERE status='待发送'`)
	}
	if err == nil {
		_, err = db.Exec(`UPDATE notifications SET status=CASE
			WHEN EXISTS (SELECT 1 FROM notification_channels c WHERE c.notification_id=notifications.id AND c.status='成功')
				THEN CASE WHEN EXISTS (SELECT 1 FROM notification_channels c WHERE c.notification_id=notifications.id AND c.status!='成功') THEN '部分成功' ELSE '成功' END
			WHEN EXISTS (SELECT 1 FROM notification_channels c WHERE c.notification_id=notifications.id AND c.status='不确定') THEN '不确定'
			WHEN EXISTS (SELECT 1 FROM notification_channels c WHERE c.notification_id=notifications.id AND c.status='失败') THEN '失败'
			WHEN EXISTS (SELECT 1 FROM notification_channels c WHERE c.notification_id=notifications.id) THEN '命中但未通知（中断前未发送）'
			ELSE '不确定' END,
			error='进程中断，请查看各渠道发送结果' WHERE status='不确定' AND error='进程中断，推送结果未知' AND EXISTS (SELECT 1 FROM notification_channels c WHERE c.notification_id=notifications.id)`)
	}
	if err == nil {
		_, err = db.Exec(`UPDATE results SET alert_status=(SELECT status FROM notifications WHERE notifications.run_id=results.run_id AND notifications.symbol=results.symbol ORDER BY id DESC LIMIT 1) WHERE alert_status='发送中'`)
	}
	if err == nil {
		err = pruneHistory(db, time.Now().UTC())
	}
	if err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func migrate(db *sql.DB) error {
	// Rebuilding runs widens its CHECK constraint. Disable FK enforcement only
	// around this atomic migration; restore it even when migration fails.
	if _, err := db.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
		return err
	}
	defer db.Exec(`PRAGMA foreign_keys=ON`)
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int
	if err = tx.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	// Version 18 was released only for the now-removed transaction ledger.
	// Its extra tables and runs column do not affect the monitor, so retain
	// compatibility instead of requiring users to replace their database.
	if version > 19 {
		return fmt.Errorf("数据库版本 %d 比程序新；请恢复匹配版本", version)
	}
	if version == 0 {
		schema := []string{
			`CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK(id=1), salt BLOB NOT NULL, hash BLOB NOT NULL)`,
			`CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at TEXT NOT NULL)`,
			`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), api_key TEXT NOT NULL DEFAULT '')`,
			`INSERT INTO settings(id) VALUES(1)`,
			`CREATE TABLE stocks (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)))`,
			`CREATE TABLE runs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind='manual'), started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '')`,
			`CREATE TABLE results (run_id INTEGER NOT NULL REFERENCES runs(id), symbol TEXT NOT NULL, price TEXT NOT NULL DEFAULT '', quote_at TEXT NOT NULL DEFAULT '', fetched_at TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', delay TEXT NOT NULL DEFAULT '未知', status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', PRIMARY KEY(run_id,symbol))`,
		}
		for _, stmt := range schema {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}
	if version < 2 {
		if _, err = tx.Exec(`ALTER TABLE results ADD COLUMN time_field TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("迁移失败: %w", err)
		}
		if _, err = tx.Exec(`PRAGMA user_version=2`); err != nil {
			return err
		}
	}
	if version < 3 {
		for _, stmt := range []string{
			`ALTER TABLE settings ADD COLUMN bark_url TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE settings ADD COLUMN bark_key TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE settings ADD COLUMN bark_local INTEGER NOT NULL DEFAULT 0`,
			`CREATE TABLE levels (id INTEGER PRIMARY KEY, stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE, side TEXT NOT NULL CHECK(side IN ('buy','sell')), target TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), generation INTEGER NOT NULL DEFAULT 1, alerted_generation INTEGER)`,
			`CREATE TABLE notifications (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), symbol TEXT NOT NULL, price TEXT NOT NULL, quote_at TEXT NOT NULL, levels TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
			`ALTER TABLE results ADD COLUMN alert_status TEXT NOT NULL DEFAULT ''`,
			`PRAGMA user_version=3`,
		} {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}
	if version < 4 {
		for _, stmt := range []string{
			`CREATE TABLE runs_new (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('manual','scheduled')), started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', schedule_id INTEGER, slot TEXT)`,
			`INSERT INTO runs_new(id,kind,started_at,finished_at,status,reason) SELECT id,kind,started_at,finished_at,status,reason FROM runs`,
			`DROP TABLE runs`,
			`ALTER TABLE runs_new RENAME TO runs`,
			`CREATE UNIQUE INDEX scheduled_once ON runs(schedule_id,slot) WHERE schedule_id IS NOT NULL`,
			`CREATE TABLE schedules (id INTEGER PRIMARY KEY, hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23), minute INTEGER NOT NULL CHECK(minute BETWEEN 0 AND 59), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), UNIQUE(hour,minute))`,
			`ALTER TABLE settings ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'`,
			`CREATE TABLE quote_calls (at TEXT NOT NULL)`,
			`CREATE INDEX quote_calls_at ON quote_calls(at)`,
			`PRAGMA user_version=4`,
		} {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}
	if version < 5 {
		if _, err = tx.Exec(`ALTER TABLE runs ADD COLUMN slot_at TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("迁移失败: %w", err)
		}
		if _, err = tx.Exec(`PRAGMA user_version=5`); err != nil {
			return err
		}
	}
	if version < 6 {
		for _, stmt := range []string{
			`CREATE INDEX results_symbol_run ON results(symbol,run_id DESC)`,
			`CREATE INDEX results_symbol_ok ON results(symbol,run_id DESC) WHERE status='ok'`,
			`CREATE INDEX levels_stock_side ON levels(stock_id,side)`,
			`CREATE INDEX notifications_symbol ON notifications(symbol,id DESC)`,
			`CREATE INDEX notifications_run ON notifications(run_id)`,
			`CREATE INDEX runs_slot ON runs(slot) WHERE kind='scheduled'`,
			`PRAGMA user_version=6`,
		} {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}
	if version < 7 {
		for _, stmt := range []string{
			`ALTER TABLE levels ADD COLUMN mode TEXT NOT NULL DEFAULT 'once' CHECK(mode IN ('once','repeat'))`,
			`ALTER TABLE levels ADD COLUMN cooldown INTEGER NOT NULL DEFAULT 60 CHECK(cooldown BETWEEN 1 AND 10080)`,
			`ALTER TABLE levels ADD COLUMN last_attempt TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE results ADD COLUMN asset_ok INTEGER NOT NULL DEFAULT 0`,
			`PRAGMA user_version=7`,
		} {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}
	if version < 8 {
		for _, stmt := range []string{
			`CREATE TABLE query_windows (id INTEGER PRIMARY KEY AUTOINCREMENT, start INTEGER NOT NULL CHECK(start BETWEEN 0 AND 1439), end INTEGER NOT NULL CHECK(end BETWEEN 0 AND 1439 AND end!=start), interval INTEGER NOT NULL CHECK(interval BETWEEN 1 AND 1439), max_alerts INTEGER NOT NULL CHECK(max_alerts BETWEEN 1 AND 1000), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)))`,
			`ALTER TABLE notifications ADD COLUMN window_id INTEGER NOT NULL DEFAULT 0`,
			`ALTER TABLE notifications ADD COLUMN window_day TEXT NOT NULL DEFAULT ''`,
			`CREATE INDEX notifications_window ON notifications(window_id,window_day,symbol,status)`,
			`PRAGMA user_version=8`,
		} {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}
	if version < 9 {
		if _, err = tx.Exec(`ALTER TABLE stocks ADD COLUMN reference_buy TEXT NOT NULL DEFAULT ''; PRAGMA user_version=9`); err != nil {
			return fmt.Errorf("迁移失败: %w", err)
		}
	}
	if version < 10 {
		if _, err = tx.Exec(`ALTER TABLE results ADD COLUMN previous_close TEXT NOT NULL DEFAULT ''; PRAGMA user_version=10`); err != nil {
			return fmt.Errorf("迁移失败: %w", err)
		}
	}
	if version < 11 {
		for _, stmt := range []string{
			`ALTER TABLE levels ADD COLUMN max_alerts INTEGER NOT NULL DEFAULT 0 CHECK(max_alerts BETWEEN 0 AND 1000)`,
			`ALTER TABLE levels ADD COLUMN uid TEXT NOT NULL DEFAULT ''`,
			`UPDATE levels SET uid=lower(hex(randomblob(16)))`,
			`CREATE UNIQUE INDEX levels_uid ON levels(uid) WHERE uid!=''`,
			// Preserve current-window usage for existing levels when upgrading.
			`UPDATE notifications SET levels=(SELECT json_group_array(json_set(j.value,'$.uid',COALESCE((SELECT uid FROM levels WHERE id=json_extract(j.value,'$.id')),''))) FROM json_each(notifications.levels) j) WHERE window_id!=0`,
			`PRAGMA user_version=11`,
		} {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}
	if version < 12 {
		for _, stmt := range []string{
			`ALTER TABLE settings ADD COLUMN default_alerts INTEGER NOT NULL DEFAULT 3 CHECK(default_alerts BETWEEN 1 AND 1000)`,
			`PRAGMA user_version=12`,
		} {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}
	if version < 13 {
		for _, stmt := range []string{
			`ALTER TABLE settings ADD COLUMN bark_enabled INTEGER NOT NULL DEFAULT 0`,
			`UPDATE settings SET bark_enabled=1 WHERE bark_url!='' AND bark_key!=''`,
			`ALTER TABLE settings ADD COLUMN feishu_webhook TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE settings ADD COLUMN feishu_secret TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE settings ADD COLUMN feishu_enabled INTEGER NOT NULL DEFAULT 0`,
			`ALTER TABLE settings ADD COLUMN tg_token TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE settings ADD COLUMN tg_chat_id TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE settings ADD COLUMN tg_enabled INTEGER NOT NULL DEFAULT 0`,
			`CREATE TABLE notification_channels (notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE, channel TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', PRIMARY KEY(notification_id,channel))`,
			`PRAGMA user_version=13`,
		} {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}
	if version < 14 {
		for _, stmt := range []string{
			`ALTER TABLE settings ADD COLUMN proxy_url TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE settings ADD COLUMN proxy_ip TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE settings ADD COLUMN proxy_tested_at TEXT NOT NULL DEFAULT ''`,
			`PRAGMA user_version=14`,
		} {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}
	if version < 15 {
		for _, stmt := range []string{
			`ALTER TABLE settings ADD COLUMN bark_proxy INTEGER NOT NULL DEFAULT 0 CHECK(bark_proxy IN (0,1))`,
			`ALTER TABLE settings ADD COLUMN feishu_proxy INTEGER NOT NULL DEFAULT 0 CHECK(feishu_proxy IN (0,1))`,
			`ALTER TABLE settings ADD COLUMN tg_proxy INTEGER NOT NULL DEFAULT 0 CHECK(tg_proxy IN (0,1))`,
			`UPDATE settings SET feishu_proxy=1,tg_proxy=1 WHERE proxy_url!=''`,
			`PRAGMA user_version=15`,
		} {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}
	if version < 16 {
		for _, stmt := range []string{
			`ALTER TABLE settings ADD COLUMN proxy_speed_mbps TEXT NOT NULL DEFAULT ''`,
			`UPDATE settings SET proxy_ip='',proxy_tested_at=''`,
			`PRAGMA user_version=16`,
		} {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}
	if version < 17 {
		for _, stmt := range []string{
			`ALTER TABLE settings RENAME COLUMN proxy_speed_mbps TO proxy_latency_ms`,
			`UPDATE settings SET proxy_latency_ms='',proxy_tested_at=''`,
			`PRAGMA user_version=17`,
		} {
			if _, err = tx.Exec(stmt); err != nil {
				return fmt.Errorf("迁移失败: %w", err)
			}
		}
	}

	if version < 19 {
		if _, err = tx.Exec(`ALTER TABLE results ADD COLUMN open TEXT NOT NULL DEFAULT ''; PRAGMA user_version=19`); err != nil {
			return fmt.Errorf("迁移失败: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	var violations int
	if err := db.QueryRow(`SELECT count(*) FROM pragma_foreign_key_check`).Scan(&violations); err != nil {
		return err
	}
	if violations != 0 {
		return fmt.Errorf("迁移后存在 %d 项外键错误", violations)
	}
	return nil
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func listStocks(db *sql.DB) ([]Stock, error) {
	rows, err := db.Query(`SELECT s.id,s.symbol,s.note,s.enabled,s.reference_buy,
  COALESCE(price.price,''),COALESCE(price.quote_at,''),COALESCE(price.source,''),COALESCE(price.previous_close,''),COALESCE(price.open,''),
  COALESCE(latest.status,''),COALESCE(latest.error,''),COALESCE(price.time_field,''),COALESCE(price.asset_ok,0)
  FROM stocks s
  LEFT JOIN results latest ON latest.symbol=s.symbol AND latest.run_id=(SELECT MAX(run_id) FROM results WHERE symbol=s.symbol)
  LEFT JOIN results price ON price.symbol=s.symbol AND price.run_id=(SELECT MAX(run_id) FROM results WHERE symbol=s.symbol AND status='ok')
  ORDER BY s.symbol`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	stocks := []Stock{}
	for rows.Next() {
		var s Stock
		if err := rows.Scan(&s.ID, &s.Symbol, &s.Note, &s.Enabled, &s.ReferenceBuy, &s.LastPrice, &s.LastAt, &s.LastSource, &s.PrevClose, &s.Open, &s.LastStatus, &s.LastError, &s.TimeField, &s.AssetOK); err != nil {
			return nil, err
		}
		s.DayChange, s.DayPercent, s.DayClass = dayMove(s.LastPrice, s.PrevClose)
		stocks = append(stocks, s)
	}
	return stocks, rows.Err()
}

func dayMove(price, previous string) (string, string, string) {
	p, err := decimal.NewFromString(price)
	if err != nil || !p.IsPositive() {
		return "", "", ""
	}
	prev, err := decimal.NewFromString(previous)
	if err != nil || !prev.IsPositive() {
		return "", "", ""
	}
	diff := p.Sub(prev)
	class := "flat"
	if diff.IsPositive() {
		class = "up"
	} else if diff.IsNegative() {
		class = "down"
	}
	sign := ""
	if diff.IsPositive() {
		sign = "+"
	}
	return sign + diff.StringFixed(2), sign + diff.Div(prev).Mul(decimal.NewFromInt(100)).StringFixed(2) + "%", class
}

func getStock(db *sql.DB, id int64) (Stock, error) {
	var s Stock
	err := db.QueryRow(`SELECT id,symbol,note,enabled,reference_buy FROM stocks WHERE id=?`, id).Scan(&s.ID, &s.Symbol, &s.Note, &s.Enabled, &s.ReferenceBuy)
	return s, err
}

func listStockQuotes(db *sql.DB, symbol string) ([]StockQuote, error) {
	rows, err := db.Query(`SELECT run_id,price,open,previous_close,quote_at,fetched_at,source,status,error,alert_status
		FROM results WHERE symbol=? ORDER BY run_id DESC LIMIT 30`, symbol)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	quotes := []StockQuote{}
	for rows.Next() {
		var q StockQuote
		if err := rows.Scan(&q.RunID, &q.Price, &q.Open, &q.PrevClose, &q.QuoteAt, &q.FetchedAt, &q.Source, &q.Status, &q.Error, &q.AlertStatus); err != nil {
			return nil, err
		}
		quotes = append(quotes, q)
	}
	return quotes, rows.Err()
}

func listRuns(db *sql.DB) ([]Run, error) {
	rows, err := db.Query(`SELECT id,kind,status,reason,started_at,COALESCE(finished_at,''),(SELECT count(*) FROM results WHERE run_id=runs.id AND status!='pending'),(SELECT count(*) FROM results WHERE run_id=runs.id) FROM runs ORDER BY id DESC LIMIT 25`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []Run{}
	for rows.Next() {
		var r Run
		if err := rows.Scan(&r.ID, &r.Kind, &r.Status, &r.Reason, &r.StartedAt, &r.FinishedAt, &r.Done, &r.Total); err != nil {
			return nil, err
		}
		runs = append(runs, r)
	}
	return runs, rows.Err()
}

func getRun(db *sql.DB, id int64) (Run, error) {
	var r Run
	err := db.QueryRow(`SELECT id,kind,status,reason,started_at,slot_at,COALESCE(finished_at,'') FROM runs WHERE id=?`, id).Scan(&r.ID, &r.Kind, &r.Status, &r.Reason, &r.StartedAt, &r.SlotAt, &r.FinishedAt)
	if err != nil {
		return r, err
	}
	rows, err := db.Query(`SELECT symbol,price,open,previous_close,quote_at,fetched_at,source,time_field,delay,status,error,alert_status FROM results WHERE run_id=? ORDER BY symbol`, id)
	if err != nil {
		return r, err
	}
	defer rows.Close()
	r.Results = []Result{}
	for rows.Next() {
		var v Result
		if err := rows.Scan(&v.Symbol, &v.Price, &v.Open, &v.PrevClose, &v.QuoteAt, &v.FetchedAt, &v.Source, &v.TimeField, &v.Delay, &v.Status, &v.Error, &v.AlertStatus); err != nil {
			return r, err
		}
		r.Total++
		if v.Status != "pending" {
			r.Done++
		}
		r.Results = append(r.Results, v)
	}
	return r, rows.Err()
}

func createRun(db *sql.DB, stocks []Stock, kind string, scheduleID int64, due, slotAt string) (int64, error) {
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`INSERT INTO runs(kind,started_at,status,schedule_id,slot,slot_at) VALUES(?,?,'running',NULLIF(?,0),NULLIF(?,''),?)`, kind, now(), scheduleID, due, slotAt)
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	for _, s := range stocks {
		if _, err = tx.Exec(`INSERT INTO results(run_id,symbol,status) VALUES(?,?,'pending')`, id, s.Symbol); err != nil {
			return 0, err
		}
	}
	return id, tx.Commit()
}

func saveResult(db *sql.DB, id int64, v Result) error {
	_, err := db.Exec(`UPDATE results SET price=?,open=?,previous_close=?,quote_at=?,fetched_at=?,source=?,time_field=?,delay=?,status=?,error=?,alert_status=?,asset_ok=? WHERE run_id=? AND symbol=?`, v.Price, v.Open, v.PrevClose, v.QuoteAt, v.FetchedAt, v.Source, v.TimeField, v.Delay, v.Status, v.Error, v.AlertStatus, v.AssetOK, id, v.Symbol)
	return err
}

func finishRun(db *sql.DB, id int64, reason string) error {
	_, err := db.Exec(`UPDATE results SET status='interrupted',error='查询未完成' WHERE run_id=? AND status='pending'`, id)
	if err != nil {
		return err
	}
	var ok, bad, skipped, missedAlerts int
	err = db.QueryRow(`SELECT count(*) FILTER (WHERE status='ok'),
		count(*) FILTER (WHERE status NOT IN ('ok','skipped')),
		count(*) FILTER (WHERE status='skipped'),
		count(*) FILTER (WHERE alert_status IN ('失败','不确定','部分成功') OR alert_status LIKE '命中但未通知%')
		FROM results WHERE run_id=?`, id).Scan(&ok, &bad, &skipped, &missedAlerts)
	if err != nil {
		return err
	}
	status := "completed"
	if ok == 0 && bad == 0 && skipped > 0 {
		status = "skipped"
	} else if ok == 0 {
		status = "failed"
	} else if bad > 0 || missedAlerts > 0 {
		status = "partial"
	}
	if reason != "" {
		status = "partial"
	}
	if strings.Contains(reason, "中断") {
		status = "interrupted"
	}
	if reason == "" {
		switch {
		case skipped > 0 && bad == 0 && ok == 0:
			reason = "查询时段结束、暂停或提醒已达上限"
		case bad > 0 && ok == 0:
			reason = "全部股票查询失败"
		case bad > 0:
			reason = "部分股票查询失败"
		case missedAlerts > 0:
			reason = "部分提醒未送达"
		}
	}
	_, err = db.Exec(`UPDATE runs SET status=?,reason=?,finished_at=? WHERE id=?`, status, reason, now(), id)
	return err
}

func value(db *sql.DB, query string, args ...any) (string, error) {
	var s string
	err := db.QueryRow(query, args...).Scan(&s)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return s, err
}

func ping(ctx context.Context, db *sql.DB) error { return db.PingContext(ctx) }

func pruneHistory(db *sql.DB, at time.Time) error {
	cutoff := at.AddDate(0, 0, -90).UTC().Format("2006-01-02")
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	old := `SELECT id FROM runs WHERE substr(started_at,1,10) < ? AND status != 'running'`
	for _, table := range []string{"notifications", "results"} {
		if _, err = tx.Exec(`DELETE FROM `+table+` WHERE run_id IN (`+old+`)`, cutoff); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`DELETE FROM runs WHERE substr(started_at,1,10) < ? AND status != 'running'`, cutoff); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM sessions WHERE julianday(expires_at) < julianday(?)`, at.UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	return tx.Commit()
}
