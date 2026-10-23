package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	marketcal "github.com/nocturnerxyz/go-marketcal"
)

var nyse = marketcal.NYSE()

func calendarReviewed(at time.Time) bool {
	year := at.In(nyse.Location()).Year()
	return year >= 2026 && year <= 2028 && nyse.InHorizon(at)
}

type barkConfig struct {
	URL, Key string
	Local    bool
}

func barkSettings(db *sql.DB) (barkConfig, error) {
	var b barkConfig
	err := db.QueryRow(`SELECT bark_url,bark_key,bark_local FROM settings WHERE id=1`).Scan(&b.URL, &b.Key, &b.Local)
	return b, err
}

func checkBarkURL(raw string, allowLocal bool) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	u, err := url.Parse(raw)
	if len(raw) > 2048 || err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || (u.Scheme != "https" && !(allowLocal && u.Scheme == "http")) {
		return "", errors.New("Bark 地址须为 HTTPS 服务根地址；内网 HTTP 需显式允许")
	}
	host := strings.ToLower(u.Hostname())
	ip := net.ParseIP(host)
	if !allowLocal && (host == "localhost" || ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast())) {
		return "", errors.New("内网地址需显式允许")
	}
	return raw, nil
}

func sendBark(ctx context.Context, b barkConfig, title, body, proxy string) (string, error) {
	payload, err := json.Marshal(map[string]string{"device_key": b.Key, "title": title, "body": body, "group": "TickerSentry"})
	if err != nil {
		return "失败", err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", b.URL+"/push", bytes.NewReader(payload))
	if err != nil {
		return "失败", errors.New("Bark 请求无效")
	}
	req.Header.Set("Content-Type", "application/json")
	// Resolve and check the Bark destination before handing the request to a proxy.
	host := req.URL.Hostname()
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return "失败", errors.New("Bark 域名解析失败")
	}
	var allowed net.IP
	for _, ip := range ips {
		if b.Local || ip.IP.IsGlobalUnicast() && !ip.IP.IsPrivate() {
			allowed = ip.IP
			break
		}
	}
	if allowed == nil {
		return "失败", errors.New("Bark 地址指向内网，需显式允许")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	if proxy != "" {
		u, _ := url.Parse(proxy)
		transport.Proxy = http.ProxyURL(u)
	} else {
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			if !strings.EqualFold(host, req.URL.Hostname()) {
				return nil, errors.New("Bark 连接地址不匹配")
			}
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, net.JoinHostPort(allowed.String(), port))
		}
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return "不确定", errors.New("Bark 网络异常或超时，发送结果不确定")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "失败", fmt.Errorf("Bark HTTP %d", resp.StatusCode)
	}
	var result struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&result); err != nil {
		return "不确定", errors.New("Bark 响应无法确认")
	}
	if result.Code != 200 || !strings.EqualFold(result.Message, "success") {
		return "失败", fmt.Errorf("Bark 拒绝请求 (code %d)", result.Code)
	}
	return "成功", nil
}

// The same reviewed calendar gates both the execution instant and the quote instant.
func alertValidity(q Quote, fetched time.Time) string {
	if !calendarReviewed(fetched) || !calendarReviewed(q.At) {
		return "交易日历超出已核验年份，未触价"
	}
	if !nyse.IsOpen(fetched) {
		return "市场休市，未触价"
	}
	if q.TimeField != "last_update_at" && q.TimeField != "last_quote_at" {
		return "缺少可用的行情时间字段，未触价"
	}
	if !q.AssetOK {
		return "资产类型或交易所未核验，未执行价格提醒判断"
	}
	open, close, ok := nyse.RegularHours(fetched)
	if !ok || q.At.Before(open) || !q.At.Before(close) {
		return "报价不属于当日常规时段，未触价"
	}
	age := fetched.Sub(q.At)
	if age < -2*time.Minute || age > 30*time.Minute {
		return "行情过期或时间异常，未触价"
	}
	return ""
}

func createAttempt(db *sql.DB, runID int64, q Quote, levels []Level, status string) (int64, error) {
	return recordAttempt(db, runID, q, levels, status, 0, "")
}
func createWindowAttempt(db *sql.DB, runID int64, q Quote, levels []Level, window *QueryWindow, day string, channels []string) (int64, error) {
	var id int64
	if window != nil {
		id = window.ID
	}
	return recordAttemptChannels(db, runID, q, levels, "发送中", id, day, channels)
}
func recordAttempt(db *sql.DB, runID int64, q Quote, levels []Level, status string, windowID int64, day string) (int64, error) {
	return recordAttemptChannels(db, runID, q, levels, status, windowID, day, nil)
}
func recordAttemptChannels(db *sql.DB, runID int64, q Quote, levels []Level, status string, windowID int64, day string, channels []string) (int64, error) {
	snapshots := make([]map[string]any, 0, len(levels))
	for _, l := range levels {
		snapshots = append(snapshots, map[string]any{"id": l.ID, "uid": l.UID, "generation": l.Generation, "side": l.Side, "target": l.Target})
	}
	data, _ := json.Marshal(snapshots)
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`INSERT INTO notifications(run_id,symbol,price,quote_at,levels,status,created_at,window_id,window_day) VALUES(?,?,?,?,?,?,?,?,?)`, runID, q.Symbol, q.Price.String(), q.At.Format(time.RFC3339Nano), string(data), status, now(), windowID, day)
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	for _, channel := range channels {
		if _, err = tx.Exec(`INSERT INTO notification_channels(notification_id,channel,status) VALUES(?,?,'待发送')`, id, channel); err != nil {
			return 0, err
		}
	}
	if _, err = tx.Exec(`UPDATE results SET alert_status=? WHERE run_id=? AND symbol=?`, status, runID, q.Symbol); err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

func updateChannel(db *sql.DB, id int64, channel, status, detail string) error {
	_, err := db.Exec(`UPDATE notification_channels SET status=?,error=? WHERE notification_id=? AND channel=?`, status, detail, id, channel)
	return err
}

func finishAttempt(db *sql.DB, id, runID int64, symbol, status, detail string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE notifications SET status=?,error=? WHERE id=?`, status, detail, id); err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE results SET alert_status=? WHERE run_id=? AND symbol=?`, status, runID, symbol); err != nil {
		return err
	}
	return tx.Commit()
}

func (a *App) alert(runID int64, s Stock, q Quote, fetched time.Time) (string, error) {
	if why := alertValidity(q, fetched); why != "" {
		return why, nil
	}
	// A stock paused or changed while the network call ran must not be newly alerted.
	current, err := getStock(a.db, s.ID)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (!current.Enabled || current.Symbol != s.Symbol) {
		return "股票已变更，未触价", nil
	}
	if err != nil {
		return "", err
	}
	levels, err := dueLevels(a.db, s.ID, q.Price)
	if err != nil {
		return "", err
	}
	if len(levels) == 0 {
		return "价格未命中已启用的提醒", nil
	}
	c, err := notificationSettings(a.db)
	if err != nil {
		return "", err
	}
	channels := c.enabled()
	if len(channels) == 0 {
		_, err = createAttempt(a.db, runID, q, levels, "命中但未通知（无启用渠道）")
		return "命中但未通知（无启用渠道）", err
	}
	window, day, err := a.activeWindow(time.Now())
	if err != nil {
		return "", err
	}
	if window != nil {
		usage, err := a.windowUsage(window, day, s.Symbol)
		if err != nil {
			return "", err
		}
		eligible := levels[:0]
		for _, l := range levels {
			if usage[l.UID] < l.alertLimit(window) {
				eligible = append(eligible, l)
			}
		}
		levels = eligible
		if len(levels) == 0 {
			return "命中档位已达本时段上限", nil
		}
	}
	id, err := createWindowAttempt(a.db, runID, q, levels, window, day, channels)
	if err != nil {
		return "", err
	}
	lines := make([]string, 0, len(levels))
	for _, l := range levels {
		side := "买入"
		if l.Side == "sell" {
			side = "卖出"
		}
		op := "≤"
		if l.Side == "sell" {
			op = "≥"
		}
		lines = append(lines, side+" "+op+" "+formatPrice(l.Target)+" USD")
	}
	body := strings.Join(lines, "\n") + fmt.Sprintf("\n查询价 %s USD · 行情时间 %s · %s\n仅供提醒，非交易指令", q.Price.StringFixed(2), q.At.Format(time.RFC3339), q.Source)
	results := make([]channelResult, 0, len(channels))
	for _, name := range channels {
		if err := updateChannel(a.db, id, name, "发送中", ""); err != nil {
			return "", err
		}
		ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
		status, sendErr := c.send(ctx, name, "触价提醒 · "+s.Symbol, body)
		cancel()
		detail := ""
		if sendErr != nil {
			detail = sendErr.Error()
		}
		if err := updateChannel(a.db, id, name, status, detail); err != nil {
			return "", err
		}
		results = append(results, channelResult{Name: name, Status: status, Error: detail})
	}
	status := channelStatus(results)
	detail := ""
	if status != "成功" {
		detail = "请查看各渠道发送结果"
	}
	if err := finishAttempt(a.db, id, runID, s.Symbol, status, detail); err != nil {
		return "", err
	}
	return status, nil
}
