package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const backupLimit = 2 << 20

type configBackup struct {
	Format    string
	Version   int
	CreatedAt string
	Settings  backupSettings
	Stocks    []backupStock
	Schedules []backupSchedule
	Windows   []QueryWindow
}
type backupSettings struct {
	APIKey, BarkURL, BarkKey, Timezone string
	BarkLocal, BarkEnabled             bool
	FeishuWebhook, FeishuSecret        string
	FeishuEnabled                      bool
	TGToken, TGChatID                  string
	TGEnabled                          bool
	ProxyURL                           string
	BarkProxy, FeishuProxy, TGProxy    bool
	DefaultAlerts                      int
}
type backupStock struct {
	Symbol, Note, ReferenceBuy string
	Enabled                    bool
	Levels                     []backupLevel
}
type backupLevel struct {
	Side, Target, Note, Mode string
	Cooldown, MaxAlerts      int
	Enabled, Alerted         bool
	LastAttempt              string
}
type backupSchedule struct {
	Hour, Minute int
	Enabled      bool
}

func exportConfig(db *sql.DB) (configBackup, error) {
	b := configBackup{Format: "TickerSentry", Version: 7, CreatedAt: now(), Stocks: []backupStock{}, Schedules: []backupSchedule{}}
	tx, err := db.Begin()
	if err != nil {
		return b, err
	}
	defer tx.Rollback()
	err = tx.QueryRow(`SELECT api_key,bark_url,bark_key,bark_local,bark_enabled,feishu_webhook,feishu_secret,feishu_enabled,tg_token,tg_chat_id,tg_enabled,timezone,default_alerts,proxy_url,bark_proxy,feishu_proxy,tg_proxy FROM settings WHERE id=1`).Scan(&b.Settings.APIKey, &b.Settings.BarkURL, &b.Settings.BarkKey, &b.Settings.BarkLocal, &b.Settings.BarkEnabled, &b.Settings.FeishuWebhook, &b.Settings.FeishuSecret, &b.Settings.FeishuEnabled, &b.Settings.TGToken, &b.Settings.TGChatID, &b.Settings.TGEnabled, &b.Settings.Timezone, &b.Settings.DefaultAlerts, &b.Settings.ProxyURL, &b.Settings.BarkProxy, &b.Settings.FeishuProxy, &b.Settings.TGProxy)
	if err != nil {
		return b, err
	}
	rows, err := tx.Query(`SELECT id,symbol,note,enabled,reference_buy FROM stocks ORDER BY symbol`)
	if err != nil {
		return b, err
	}
	ids := map[int64]int{}
	for rows.Next() {
		var id int64
		var s backupStock
		if err = rows.Scan(&id, &s.Symbol, &s.Note, &s.Enabled, &s.ReferenceBuy); err != nil {
			rows.Close()
			return b, err
		}
		s.Levels = []backupLevel{}
		ids[id] = len(b.Stocks)
		b.Stocks = append(b.Stocks, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return b, err
	}
	rows, err = tx.Query(`SELECT stock_id,side,target,note,mode,cooldown,enabled,COALESCE(alerted_generation=generation,0),last_attempt,max_alerts FROM levels ORDER BY id`)
	if err != nil {
		return b, err
	}
	for rows.Next() {
		var id int64
		var l backupLevel
		if err = rows.Scan(&id, &l.Side, &l.Target, &l.Note, &l.Mode, &l.Cooldown, &l.Enabled, &l.Alerted, &l.LastAttempt, &l.MaxAlerts); err != nil {
			rows.Close()
			return b, err
		}
		i, ok := ids[id]
		if !ok {
			rows.Close()
			return b, errors.New("档位所属股票不存在")
		}
		b.Stocks[i].Levels = append(b.Stocks[i].Levels, l)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return b, err
	}
	rows, err = tx.Query(`SELECT hour,minute,enabled FROM schedules ORDER BY hour,minute`)
	if err != nil {
		return b, err
	}
	for rows.Next() {
		var s backupSchedule
		if err = rows.Scan(&s.Hour, &s.Minute, &s.Enabled); err != nil {
			rows.Close()
			return b, err
		}
		b.Schedules = append(b.Schedules, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return b, err
	}
	rows, err = tx.Query(`SELECT id,start,end,interval,max_alerts,enabled FROM query_windows ORDER BY start`)
	if err != nil {
		return b, err
	}
	for rows.Next() {
		var w QueryWindow
		if err = rows.Scan(&w.ID, &w.Start, &w.End, &w.Interval, &w.MaxAlerts, &w.Enabled); err != nil {
			rows.Close()
			return b, err
		}
		b.Windows = append(b.Windows, w)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return b, err
	}
	return b, tx.Commit()
}

func validateConfig(b *configBackup) error {
	if b.Format != "TickerSentry" || b.Version < 1 || b.Version > 7 {
		return errors.New("不是支持的 TickerSentry 配置备份（版本 1 至 7）")
	}
	s := &b.Settings
	if s.ProxyURL != "" {
		var err error
		s.ProxyURL, err = checkProxy(s.ProxyURL)
		if err != nil {
			return err
		}
	}
	if b.Version < 7 {
		s.FeishuProxy = s.ProxyURL != ""
		s.TGProxy = s.ProxyURL != ""
	}
	if s.ProxyURL == "" && (s.BarkProxy || s.FeishuProxy || s.TGProxy) {
		return errors.New("备份中通知渠道选择了代理，但未配置代理地址")
	}
	if b.Version < 4 {
		s.DefaultAlerts = 3
	}
	if b.Version < 5 {
		s.BarkEnabled = s.BarkURL != "" && s.BarkKey != ""
	}
	if s.DefaultAlerts < 1 || s.DefaultAlerts > 1000 {
		return errors.New("备份默认提醒上限无效")
	}
	if s.Timezone != "Asia/Shanghai" && s.Timezone != "America/New_York" {
		return errors.New("备份时区无效")
	}
	if len(s.APIKey) > 256 || len(s.BarkKey) > 256 {
		return errors.New("备份中的 Key 过长")
	}
	if s.BarkURL != "" {
		var err error
		s.BarkURL, err = checkBarkURL(s.BarkURL, s.BarkLocal)
		if err != nil {
			return err
		}
	}
	if s.BarkEnabled && (s.BarkURL == "" || s.BarkKey == "") {
		return errors.New("备份中的 Bark 配置不完整")
	}
	if s.FeishuWebhook != "" {
		var err error
		s.FeishuWebhook, err = checkFeishuWebhook(s.FeishuWebhook)
		if err != nil {
			return err
		}
	}
	if len(s.FeishuSecret) > 256 || s.FeishuEnabled && s.FeishuWebhook == "" {
		return errors.New("备份中的飞书配置无效")
	}
	if s.TGToken != "" || s.TGChatID != "" {
		if err := checkTG(s.TGToken, s.TGChatID); err != nil {
			return err
		}
	}
	if s.TGEnabled && (s.TGToken == "" || s.TGChatID == "") {
		return errors.New("备份中的 Telegram 配置不完整")
	}
	if len(b.Stocks) > 1000 || len(b.Schedules) > 1440 {
		return errors.New("备份配置数量过多")
	}
	seen := map[string]bool{}
	total := 0
	for i := range b.Stocks {
		stock := &b.Stocks[i]
		if !symbolPattern.MatchString(stock.Symbol) || seen[stock.Symbol] || len(stock.Note) > 200 {
			return errors.New("备份股票代码重复、无效或备注过长")
		}
		if stock.ReferenceBuy != "" {
			target, err := parseTarget(stock.ReferenceBuy)
			if err != nil {
				return errors.New("备份收益参考买入价无效")
			}
			stock.ReferenceBuy = target
		}
		seen[stock.Symbol] = true
		total += len(stock.Levels)
		if total > 10000 {
			return errors.New("备份档位过多")
		}
		for j := range stock.Levels {
			l := &stock.Levels[j]
			target, err := parseTarget(l.Target)
			if err != nil {
				return err
			}
			l.Target = target
			if (l.Side != "buy" && l.Side != "sell") || (l.Mode != "once" && l.Mode != "repeat") || l.Cooldown < 1 || l.Cooldown > 10080 || l.MaxAlerts < 0 || l.MaxAlerts > 1000 || len(l.Note) > 200 {
				return errors.New("备份档位的方向、模式、冷却时间、提醒上限或备注无效")
			}
			if l.LastAttempt != "" {
				at, err := time.Parse(time.RFC3339Nano, l.LastAttempt)
				if err != nil || at.After(time.Now().Add(2*time.Minute)) {
					return errors.New("备份提醒时间无效或在未来")
				}
			}
		}
	}
	if len(b.Windows) > 1440 {
		return errors.New("备份查询时段过多")
	}
	for i, w := range b.Windows {
		if w.ID <= 0 || !validWindow(w) {
			return errors.New("备份查询时段无效")
		}
		for _, other := range b.Windows[:i] {
			if w.ID == other.ID || windowsOverlap(w, other) {
				return errors.New("备份查询时段重复或重叠")
			}
		}
	}
	slots := map[int]bool{}
	for _, s := range b.Schedules {
		slot := s.Hour*60 + s.Minute
		if s.Hour < 0 || s.Hour > 23 || s.Minute < 0 || s.Minute > 59 || slots[slot] {
			return errors.New("备份查询时间无效或重复")
		}
		slots[slot] = true
	}
	return nil
}

func importConfig(db *sql.DB, b configBackup, proxyLatency, testedAt string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, query := range []string{`DELETE FROM levels`, `DELETE FROM stocks`, `DELETE FROM schedules`, `DELETE FROM query_windows`} {
		if _, err = tx.Exec(query); err != nil {
			return err
		}
	}
	s := b.Settings
	if _, err = tx.Exec(`UPDATE settings SET api_key=?,bark_url=?,bark_key=?,bark_local=?,bark_enabled=?,feishu_webhook=?,feishu_secret=?,feishu_enabled=?,tg_token=?,tg_chat_id=?,tg_enabled=?,timezone=?,default_alerts=?,proxy_url=?,proxy_latency_ms=?,proxy_tested_at=?,bark_proxy=?,feishu_proxy=?,tg_proxy=? WHERE id=1`, s.APIKey, s.BarkURL, s.BarkKey, s.BarkLocal, s.BarkEnabled, s.FeishuWebhook, s.FeishuSecret, s.FeishuEnabled, s.TGToken, s.TGChatID, s.TGEnabled, s.Timezone, s.DefaultAlerts, s.ProxyURL, proxyLatency, testedAt, s.BarkProxy, s.FeishuProxy, s.TGProxy); err != nil {
		return err
	}
	for _, s := range b.Stocks {
		res, err := tx.Exec(`INSERT INTO stocks(symbol,note,enabled,reference_buy) VALUES(?,?,?,?)`, s.Symbol, s.Note, s.Enabled, s.ReferenceBuy)
		if err != nil {
			return err
		}
		id, err := res.LastInsertId()
		if err != nil {
			return err
		}
		for _, l := range s.Levels {
			var alerted any
			if l.Alerted {
				alerted = 1
			}
			if _, err = tx.Exec(`INSERT INTO levels(stock_id,side,target,note,mode,cooldown,enabled,alerted_generation,last_attempt,max_alerts,uid) VALUES(?,?,?,?,?,?,?,?,?,?,lower(hex(randomblob(16))))`, id, l.Side, l.Target, l.Note, l.Mode, l.Cooldown, l.Enabled, alerted, l.LastAttempt, l.MaxAlerts); err != nil {
				return err
			}
		}
	}
	for _, s := range b.Schedules {
		if _, err = tx.Exec(`INSERT INTO schedules(hour,minute,enabled) VALUES(?,?,?)`, s.Hour, s.Minute, s.Enabled); err != nil {
			return err
		}
	}
	for _, w := range b.Windows {
		if _, err = tx.Exec(`INSERT INTO query_windows(id,start,end,interval,max_alerts,enabled) VALUES(?,?,?,?,?,?)`, w.ID, w.Start, w.End, w.Interval, w.MaxAlerts, w.Enabled); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (a *App) downloadConfig(w http.ResponseWriter, r *http.Request) {
	b, err := exportConfig(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if len(data) > backupLimit {
		a.formError(w, r, "配置超过 2 MiB，请使用 SQLite 完整备份")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="tickersentry-config-%s.json"`, time.Now().UTC().Format("20060102-150405")))
	w.Write(data)
}

func (a *App) restoreConfig(w http.ResponseWriter, r *http.Request) {
	if r.PostForm.Get("confirm") != "restore" {
		a.formError(w, r, "请勾选确认覆盖当前配置")
		return
	}
	file, _, err := r.FormFile("backup")
	if err != nil {
		a.formError(w, r, "请选择 JSON 配置备份文件")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, backupLimit+1))
	if err != nil || len(data) > backupLimit {
		a.formError(w, r, "备份文件读取失败或超过 2 MiB")
		return
	}
	var b configBackup
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&b); err != nil {
		a.formError(w, r, "备份 JSON 格式无效或含不支持的字段")
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		a.formError(w, r, "备份包含多余内容")
		return
	}
	if err = validateConfig(&b); err != nil {
		a.formError(w, r, err.Error())
		return
	}
	proxyLatency, testedAt := "", ""
	if b.Settings.ProxyURL != "" {
		proxyLatency, err = testProxy(r.Context(), b.Settings.ProxyURL)
		if err != nil {
			a.respondError(w, r, http.StatusBadGateway, "备份中的代理测试失败："+err.Error())
			return
		}
		testedAt = now()
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.runningID != 0 {
		a.respondError(w, r, 409, "查询仍在运行，请等本轮结束后恢复配置。")
		return
	}
	if err = importConfig(a.db, b, proxyLatency, testedAt); err != nil {
		a.fail(w, r, err)
		return
	}
	http.Redirect(w, r, a.href("/settings?result=restored"), http.StatusSeeOther)
}
