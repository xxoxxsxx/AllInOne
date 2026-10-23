package main

import (
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

//go:embed templates/*.html static/*
var assets embed.FS

var symbolPattern = regexp.MustCompile(`^[A-Z][A-Z0-9.-]{0,14}$`)
var pages = template.Must(template.New("pages").Funcs(template.FuncMap{"money": formatPrice}).ParseFS(assets, "templates/*.html"))

type view struct {
	EditLevel     int64
	UpdatedLevel  int64
	Readiness     []string
	Title         string
	StatusCode    int
	CSRF          string
	Error         string
	Notice        string
	Stocks        []Stock
	ActiveStocks  int
	Runs          []Run
	Run           Run
	Stock         Stock
	KeySet        bool
	APIKey        string
	BarkSet       bool
	BarkKey       string
	BarkLocal     bool
	BarkURL       string
	BarkNotice    string
	BarkEnabled   bool
	BarkProxy     bool
	FeishuWebhook string
	FeishuSecret  string
	FeishuEnabled bool
	FeishuProxy   bool
	TGToken       string
	TGChatID      string
	TGEnabled     bool
	TGProxy       bool
	ProxyURL      string
	ProxyLatency  string
	ProxyTestedAt string
	Levels        []Level
	Notifications []Notification
	Quotes        []StockQuote
	Schedules     []Schedule
	Windows       []QueryWindow
	Timezone      string
	NextFire      string
	QuotaPerRun   int
	QuotaDaily    int
	DefaultAlerts int
	Base          string // 公开前缀，如 /stocks；空表示根路径部署
	PortalURL     string // AllInOne 门户地址，用于“返回工具箱”
}

// H 供模板生成带公开前缀的站内链接。
func (v view) H(path string) string {
	return (&App{basePath: basePtr(v.Base)}).href(path)
}

func basePtr(b string) *string {
	if b == "" {
		return nil
	}
	return &b
}

func (view) NewLevel() Level { return Level{Mode: "once", Cooldown: 60} }

func (v view) Clock(s string) string {
	if s == "" {
		return "—"
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return s
	}
	loc, err := time.LoadLocation(v.Timezone)
	if err != nil {
		loc = time.UTC
	}
	return t.In(loc).Format("2006-01-02 15:04:05 MST")
}

func (view) Status(s string) string {
	switch s {
	case "running":
		return "查询中"
	case "completed":
		return "已完成"
	case "partial":
		return "部分完成"
	case "failed", "error":
		return "失败"
	case "skipped":
		return "已跳过"
	case "interrupted":
		return "已中断"
	case "pending":
		return "等待中"
	case "ok":
		return "成功"
	default:
		return s
	}
}

func (a *App) routes() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /static/", func(w http.ResponseWriter, r *http.Request) {
		root, _ := fs.Sub(assets, "static")
		http.StripPrefix("/static/", http.FileServer(http.FS(root))).ServeHTTP(w, r)
	})
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := ping(r.Context(), a.db); err != nil {
			http.Error(w, "unavailable", 503)
			return
		}
		w.Write([]byte("ok"))
	})
	m.HandleFunc("GET /login", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, a.href("/"), http.StatusSeeOther)
	})
	m.HandleFunc("GET /{$}", a.secure(a.home))
	m.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
	})
	m.HandleFunc("GET /settings", a.secure(a.settingsPage))
	m.HandleFunc("POST /windows", a.secure(a.windowSave))
	m.HandleFunc("POST /windows/default", a.secure(a.windowDefault))
	m.HandleFunc("POST /windows/{id}/{action}", a.secure(a.windowSave))
	m.HandleFunc("GET /schedule", a.secure(a.schedulePage))
	m.HandleFunc("POST /schedule", a.secure(a.scheduleAdd))
	m.HandleFunc("POST /schedule/zone", a.secure(a.zonePost))
	m.HandleFunc("POST /schedule/{id}/{action}", a.secure(a.scheduleUpdate))
	m.HandleFunc("POST /backup", a.secure(a.downloadConfig))
	m.HandleFunc("POST /restore", a.secure(a.restoreConfig))
	m.HandleFunc("POST /settings", a.secure(a.settingsPost))
	m.HandleFunc("POST /stocks/{id}/reference", a.secure(a.stockReference))
	m.HandleFunc("POST /stocks", a.secure(a.stockAdd))
	m.HandleFunc("POST /stocks/{id}/levels", a.secure(a.levelAdd))
	m.HandleFunc("POST /stocks/{id}/levels/{level}/update", a.secure(a.levelUpdate))
	m.HandleFunc("POST /stocks/{id}/levels/{level}/{action}", a.secure(a.levelAction))
	m.HandleFunc("POST /api/bark/test", a.secure(a.barkTest))
	m.HandleFunc("POST /api/feishu/test", a.secure(a.feishuTest))
	m.HandleFunc("POST /api/telegram/test", a.secure(a.telegramTest))
	m.HandleFunc("GET /stocks/{id}", a.secure(a.stockPage))
	m.HandleFunc("POST /stocks/{id}/update", a.secure(a.stockUpdate))
	m.HandleFunc("POST /stocks/{id}/delete", a.secure(a.stockDelete))
	m.HandleFunc("GET /runs/{id}", a.secure(a.runPage))
	m.HandleFunc("POST /api/runs", a.secure(a.runPost))
	m.HandleFunc("GET /api/runs/{id}", a.secure(a.runGet))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Cache-Control", "no-store")
		m.ServeHTTP(w, r)
	})
}

func (a *App) secure(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if !a.sameOrigin(r) {
				a.respondError(w, r, 403, "无法确认请求来源，请重新打开本站页面后再试。")
				return
			}
			var err error
			if r.URL.Path == "/restore" {
				r.Body = http.MaxBytesReader(w, r.Body, backupLimit+(64<<10))
				err = r.ParseMultipartForm(backupLimit + (64 << 10))
				if r.MultipartForm != nil {
					defer r.MultipartForm.RemoveAll()
				}
			} else {
				r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
				err = r.ParseForm()
			}
			if err != nil {
				a.respondError(w, r, 400, "提交的内容无效或过大，请检查后再试。")
				return
			}
			token := r.Header.Get("X-CSRF-Token")
			if token == "" {
				token = r.PostForm.Get("csrf")
			}
			if !constantMatch(token, a.csrf) {
				a.respondError(w, r, 403, "页面验证已失效，请返回并刷新页面后重新提交。")
				return
			}
		}
		next(w, r)
	}
}
func render(w http.ResponseWriter, name string, v view) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := pages.ExecuteTemplate(w, name, v); err != nil {
		log.Printf("template %s: %v", name, err)
	}
}

// renderApp 为页面渲染补齐公共导航所需的视图字段。
func (a *App) renderApp(w http.ResponseWriter, name string, v view) {
	v.Base = a.base()
	v.PortalURL = portalURL()
	render(w, name, v)
}
func pathID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.New("无效编号")
	}
	return id, nil
}

func (a *App) home(w http.ResponseWriter, r *http.Request) {
	stocks, err := listStocks(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if err := homeLevels(a.db, stocks); err != nil {
		a.fail(w, r, err)
		return
	}
	active := 0
	for _, stock := range stocks {
		if stock.Enabled {
			active++
		}
	}
	key, err := value(a.db, `SELECT api_key FROM settings WHERE id=1`)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	runs, err := listRuns(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
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
	next := time.Time{}
	for _, schedule := range list {
		if schedule.Enabled {
			t := nextFire(schedule, loc, time.Now())
			if next.IsZero() || t.Before(next) {
				next = t
			}
		}
	}
	windows, err := queryWindows(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	for _, window := range windows {
		if window.Enabled {
			t := nextWindowFire(window, loc, time.Now())
			if !t.IsZero() && (next.IsZero() || t.Before(next)) {
				next = t
			}
		}
	}
	nextText := ""
	if !next.IsZero() {
		nextText = next.Format(time.RFC3339)
	}
	readiness, err := a.readiness(key != "", !next.IsZero())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	current, day, err := a.activeWindow(time.Now())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	usage := map[string]map[string]int{}
	if current != nil {
		usage, err = a.windowUsageAll(current, day)
		if err != nil {
			a.fail(w, r, err)
			return
		}
	}
	for i := range stocks {
		stocks[i].AlertReason = quoteReadiness(stocks[i])
		var levels []Level
		for _, group := range [][]Level{stocks[i].BuyLevels, stocks[i].SellLevels} {
			for j := range group {
				if current != nil {
					group[j].Used = usage[stocks[i].Symbol][group[j].UID]
					group[j].Limit = group[j].alertLimit(current)
					group[j].WindowActive = true
				}
				levels = append(levels, group[j])
			}
		}
		stocks[i].WindowStatus, stocks[i].WindowCapped = windowSummary(levels, current)
	}
	a.renderApp(w, "home", view{Notice: flashNotice(r), Title: "监控列表", Readiness: readiness, CSRF: a.csrf, Stocks: stocks, ActiveStocks: active, Runs: runs, NextFire: nextText, Timezone: name, KeySet: key != ""})
}
func (a *App) settingsPage(w http.ResponseWriter, r *http.Request) {
	key, err := value(a.db, `SELECT api_key FROM settings WHERE id=1`)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	c, err := notificationSettings(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var proxyLatency, proxyTestedAt, timezone string
	if err := a.db.QueryRow(`SELECT proxy_latency_ms,proxy_tested_at,timezone FROM settings WHERE id=1`).Scan(&proxyLatency, &proxyTestedAt, &timezone); err != nil {
		a.fail(w, r, err)
		return
	}
	var stocks, slots int
	if err := a.db.QueryRow(`SELECT (SELECT count(*) FROM stocks WHERE enabled=1), (SELECT count(*) FROM schedules WHERE enabled=1)`).Scan(&stocks, &slots); err != nil {
		a.fail(w, r, err)
		return
	}
	windows, err := queryWindows(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	for _, window := range windows {
		if window.Enabled {
			slots += (window.duration() + window.Interval - 1) / window.Interval
		}
	}
	notice := ""
	if tested := r.URL.Query().Get("tested"); tested == "bark" || tested == "feishu" || tested == "telegram" {
		notice = map[string]string{"bark": "Bark", "feishu": "飞书", "telegram": "Telegram"}[tested] + " 已接受测试通知；请在接收端核对送达"
	}
	a.renderApp(w, "settings", view{Title: "行情与通知设置", CSRF: a.csrf, KeySet: key != "", APIKey: key, BarkSet: c.Bark.Key != "", BarkKey: c.Bark.Key, BarkURL: c.Bark.URL, BarkLocal: c.Bark.Local, BarkEnabled: c.BarkEnabled, BarkProxy: c.BarkProxy, FeishuWebhook: c.FeishuWebhook, FeishuSecret: c.FeishuSecret, FeishuEnabled: c.FeishuEnabled, FeishuProxy: c.FeishuProxy, TGToken: c.TGToken, TGChatID: c.TGChatID, TGEnabled: c.TGEnabled, TGProxy: c.TGProxy, ProxyURL: c.Proxy, ProxyLatency: proxyLatency, ProxyTestedAt: proxyTestedAt, Timezone: timezone, BarkNotice: notice, Notice: map[string]string{"restored": "配置已恢复，查询和通知历史已保留；不会补跑或立即发送通知", "saved": "配置已保存", "cleared": "配置已清除", "unchanged": "未填写新 Key，已保留当前配置", "proxy_tested": "代理测试成功，响应耗时已更新"}[r.URL.Query().Get("result")], QuotaPerRun: stocks, QuotaDaily: stocks * slots})
}
func (a *App) useChannelProxy(r *http.Request) (bool, error) {
	use := r.PostForm.Get("use_proxy") == "1"
	if use {
		proxy, err := proxySetting(a.db)
		if err != nil {
			return false, err
		}
		if proxy == "" {
			return false, errors.New("请先测试并保存网络代理")
		}
	}
	return use, nil
}
func (a *App) settingsPost(w http.ResponseWriter, r *http.Request) {
	if r.PostForm.Has("proxy_clear") {
		if _, err := a.db.Exec(`UPDATE settings SET proxy_url='',proxy_latency_ms='',proxy_tested_at='',bark_proxy=0,feishu_proxy=0,tg_proxy=0 WHERE id=1`); err != nil {
			a.fail(w, r, err)
			return
		}
		http.Redirect(w, r, a.href("/settings?result=cleared#proxy-title"), http.StatusSeeOther)
		return
	}
	if r.PostForm.Has("proxy_save") || r.PostForm.Has("proxy_test") {
		raw := r.PostForm.Get("proxy_url")
		if r.PostForm.Has("proxy_test") {
			var err error
			raw, err = proxySetting(a.db)
			if err != nil {
				a.fail(w, r, err)
				return
			}
		}
		proxy, err := checkProxy(raw)
		if err != nil || proxy == "" {
			a.formError(w, r, "请填写有效的 HTTP 或 SOCKS5 代理地址和端口")
			return
		}
		latency, err := testProxy(r.Context(), proxy)
		if err != nil {
			a.respondError(w, r, http.StatusBadGateway, "代理测试失败："+err.Error())
			return
		}
		if _, err := a.db.Exec(`UPDATE settings SET proxy_url=?,proxy_latency_ms=?,proxy_tested_at=? WHERE id=1`, proxy, latency, now()); err != nil {
			a.fail(w, r, err)
			return
		}
		http.Redirect(w, r, a.href("/settings?result=proxy_tested#proxy-title"), http.StatusSeeOther)
		return
	}
	if r.PostForm.Has("feishu_clear") {
		if _, err := a.db.Exec(`UPDATE settings SET feishu_webhook='',feishu_secret='',feishu_enabled=0,feishu_proxy=0 WHERE id=1`); err != nil {
			a.fail(w, r, err)
			return
		}
		http.Redirect(w, r, a.href("/settings?result=cleared"), 303)
		return
	}
	if r.PostForm.Has("tg_clear") {
		if _, err := a.db.Exec(`UPDATE settings SET tg_token='',tg_chat_id='',tg_enabled=0,tg_proxy=0 WHERE id=1`); err != nil {
			a.fail(w, r, err)
			return
		}
		http.Redirect(w, r, a.href("/settings?result=cleared"), 303)
		return
	}
	if r.PostForm.Has("feishu_save") {
		useProxy, err := a.useChannelProxy(r)
		if err != nil {
			a.formError(w, r, err.Error())
			return
		}
		webhook, err := checkFeishuWebhook(r.PostForm.Get("feishu_webhook"))
		if err != nil {
			a.formError(w, r, err.Error())
			return
		}
		secret := strings.TrimSpace(r.PostForm.Get("feishu_secret"))
		if len(secret) > 256 {
			a.formError(w, r, "飞书签名密钥过长")
			return
		}
		if _, err = a.db.Exec(`UPDATE settings SET feishu_webhook=?,feishu_secret=?,feishu_enabled=?,feishu_proxy=? WHERE id=1`, webhook, secret, r.PostForm.Get("enabled") == "1", useProxy); err != nil {
			a.fail(w, r, err)
			return
		}
		http.Redirect(w, r, a.href("/settings?result=saved"), 303)
		return
	}
	if r.PostForm.Has("tg_save") {
		useProxy, err := a.useChannelProxy(r)
		if err != nil {
			a.formError(w, r, err.Error())
			return
		}
		token, chat := strings.TrimSpace(r.PostForm.Get("tg_token")), strings.TrimSpace(r.PostForm.Get("tg_chat_id"))
		if err := checkTG(token, chat); err != nil {
			a.formError(w, r, err.Error())
			return
		}
		if _, err := a.db.Exec(`UPDATE settings SET tg_token=?,tg_chat_id=?,tg_enabled=?,tg_proxy=? WHERE id=1`, token, chat, r.PostForm.Get("enabled") == "1", useProxy); err != nil {
			a.fail(w, r, err)
			return
		}
		http.Redirect(w, r, a.href("/settings?result=saved"), 303)
		return
	}
	if r.PostForm.Has("bark_save") {
		useProxy, err := a.useChannelProxy(r)
		if err != nil {
			a.formError(w, r, err.Error())
			return
		}
		raw := strings.TrimSpace(r.PostForm.Get("bark_url"))
		key := strings.TrimSpace(r.PostForm.Get("bark_key"))
		if len(key) > 256 {
			a.formError(w, r, "设备 Key 过长")
			return
		}
		if raw != "" {
			var err error
			raw, err = checkBarkURL(raw, r.PostForm.Get("allow_local") == "1")
			if err != nil {
				a.formError(w, r, err.Error())
				return
			}
		}
		if r.PostForm.Get("enabled") == "1" {
			current, err := barkSettings(a.db)
			if err != nil {
				a.fail(w, r, err)
				return
			}
			if raw == "" || key == "" && current.Key == "" {
				a.formError(w, r, "启用 Bark 前请填写服务地址和设备 Key")
				return
			}
		}
		if _, err := a.db.Exec(`UPDATE settings SET bark_url=?,bark_key=CASE WHEN ?='' THEN bark_key ELSE ? END,bark_local=?,bark_enabled=?,bark_proxy=? WHERE id=1`, raw, key, key, r.PostForm.Get("allow_local") == "1", r.PostForm.Get("enabled") == "1", useProxy); err != nil {
			a.fail(w, r, err)
			return
		}
		http.Redirect(w, r, a.href("/settings?result=saved"), 303)
		return
	}
	if r.PostForm.Has("bark_clear") {
		if _, err := a.db.Exec(`UPDATE settings SET bark_url='',bark_key='',bark_local=0,bark_enabled=0,bark_proxy=0 WHERE id=1`); err != nil {
			a.fail(w, r, err)
			return
		}
		http.Redirect(w, r, a.href("/settings?result=cleared"), 303)
		return
	}
	key := strings.TrimSpace(r.PostForm.Get("api_key"))
	if len(key) > 256 {
		a.formError(w, r, "Key 过长")
		return
	}
	if r.PostForm.Get("clear") != "1" && key == "" {
		http.Redirect(w, r, a.href("/settings?result=unchanged"), 303)
		return
	}
	if r.PostForm.Get("clear") == "1" {
		key = ""
	}
	if _, err := a.db.Exec(`UPDATE settings SET api_key=? WHERE id=1`, key); err != nil {
		a.fail(w, r, err)
		return
	}
	result := "saved"
	if r.PostForm.Get("clear") == "1" {
		result = "cleared"
	}
	http.Redirect(w, r, a.href("/settings?result="+result), 303)
}
func stockFields(r *http.Request) (string, string, bool, error) {
	symbol := strings.ToUpper(strings.TrimSpace(r.PostForm.Get("symbol")))
	note := strings.TrimSpace(r.PostForm.Get("note"))
	if !symbolPattern.MatchString(symbol) || len(note) > 200 {
		return "", "", false, errors.New("股票代码或备注无效")
	}
	return symbol, note, r.PostForm.Get("enabled") == "1", nil
}
func (a *App) stockAdd(w http.ResponseWriter, r *http.Request) {
	symbol, note, _, err := stockFields(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	res, err := a.db.Exec(`INSERT INTO stocks(symbol,note,enabled) VALUES(?,?,1)`, symbol, note)
	if err != nil {
		a.formError(w, r, "添加失败：代码已存在或数据库不可用")
		return
	}
	id, err := res.LastInsertId()
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if r.Header.Get("Accept") == "application/json" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": id, "symbol": symbol})
		return
	}
	http.Redirect(w, r, fmt.Sprintf(a.href("/stocks/%d?flash=stock_added#add-level"), id), 303)
}
func (a *App) stockPage(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	stock, err := getStock(a.db, id)
	if errors.Is(err, sql.ErrNoRows) {
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
		return
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	levels, _, err := a.levelUsage(id, stock.Symbol, time.Now())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	notifications, err := listNotifications(a.db, stock.Symbol)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	quotes, err := listStockQuotes(a.db, stock.Symbol)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	all, err := listStocks(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	for _, item := range all {
		if item.ID == id {
			stock.LastPrice = item.LastPrice
			stock.Open = item.Open
			stock.PrevClose = item.PrevClose
			stock.DayChange = item.DayChange
			stock.DayPercent = item.DayPercent
			stock.DayClass = item.DayClass
			stock.LastAt = item.LastAt
			stock.LastSource = item.LastSource
			stock.LastStatus = item.LastStatus
			stock.LastError = item.LastError
			break
		}
	}
	for _, l := range levels {
		if l.Side == "buy" {
			stock.BuyLevels = append(stock.BuyLevels, l)
		} else {
			stock.SellLevels = append(stock.SellLevels, l)
		}
	}
	stock.setReturns()
	for i := range levels {
		if levels[i].Side == "sell" {
			levels[i].Profit = expectedReturn(stock.BuyBasis, levels[i].Target)
		}
		levels[i].Gap = targetGap(levels[i].Side, levels[i].Target, stock.LastPrice)
	}
	name, _, err := zone(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	edit, _ := strconv.ParseInt(r.URL.Query().Get("edit"), 10, 64)
	updated, _ := strconv.ParseInt(r.URL.Query().Get("updated"), 10, 64)
	a.renderApp(w, "stock", view{Notice: flashNotice(r), EditLevel: edit, UpdatedLevel: updated, Title: stock.Symbol, CSRF: a.csrf, Stock: stock, Levels: levels, Notifications: notifications, Quotes: quotes, Timezone: name})
}
func (a *App) stockUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	symbol, note, enabled, err := stockFields(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer tx.Rollback()
	var oldSymbol string
	if err = tx.QueryRow(`SELECT symbol FROM stocks WHERE id=?`, id).Scan(&oldSymbol); errors.Is(err, sql.ErrNoRows) {
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
		return
	} else if err != nil {
		a.fail(w, r, err)
		return
	}
	res, err := tx.Exec(`UPDATE stocks SET symbol=?,note=?,enabled=? WHERE id=?`, symbol, note, enabled, id)
	if err != nil {
		a.formError(w, r, "更新失败：代码已存在或数据库不可用")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
		return
	}
	if oldSymbol != symbol {
		if _, err = tx.Exec(`UPDATE levels SET generation=generation+1,alerted_generation=NULL,last_attempt='' WHERE stock_id=?`, id); err != nil {
			a.fail(w, r, err)
			return
		}
	}
	if err = tx.Commit(); err != nil {
		a.fail(w, r, err)
		return
	}
	http.Redirect(w, r, fmt.Sprintf(a.href("/stocks/%d?flash=stock_saved#stock-settings"), id), 303)
}
func (a *App) stockDelete(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	stock, err := getStock(a.db, id)
	if errors.Is(err, sql.ErrNoRows) {
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
		return
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if strings.ToUpper(strings.TrimSpace(r.PostForm.Get("confirm"))) != stock.Symbol {
		a.formError(w, r, "请输入股票代码确认删除")
		return
	}
	if _, err := a.db.Exec(`DELETE FROM stocks WHERE id=?`, id); err != nil {
		a.fail(w, r, err)
		return
	}
	http.Redirect(w, r, a.href("/?flash=stock_deleted"), 303)
}
func (a *App) runPage(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	run, err := getRun(a.db, id)
	if errors.Is(err, sql.ErrNoRows) {
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
		return
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	name, _, err := zone(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.renderApp(w, "run", view{Title: fmt.Sprintf("查询 #%d", id), CSRF: a.csrf, Run: run, Timezone: name})
}
func (a *App) runGet(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	run, err := getRun(a.db, id)
	if errors.Is(err, sql.ErrNoRows) {
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
		return
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	for i := range run.Results {
		run.Results[i].Price = formatPrice(run.Results[i].Price)
		run.Results[i].Open = formatPrice(run.Results[i].Open)
		run.Results[i].PrevClose = formatPrice(run.Results[i].PrevClose)
	}
	_ = json.NewEncoder(w).Encode(run)
}

func (a *App) stockReference(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	target, err := parseTarget(r.PostForm.Get("reference_buy"))
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	res, err := a.db.Exec(`UPDATE stocks SET reference_buy=? WHERE id=? AND EXISTS(SELECT 1 FROM levels WHERE stock_id=? AND side='buy' AND target=?)`, target, id, id, target)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		a.formError(w, r, "买入目标已变更，请刷新页面后重试")
		return
	}
	http.Redirect(w, r, a.href("/?flash=reference_saved#stock-"+strconv.FormatInt(id, 10)), 303)
}
