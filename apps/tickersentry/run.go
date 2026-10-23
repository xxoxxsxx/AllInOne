package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"
)

func (a *App) runPost(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.runningID != 0 {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": a.runningID, "status": "running"})
		return
	}
	key, err := value(a.db, `SELECT api_key FROM settings WHERE id=1`)
	if err != nil {
		fail(w, r, err)
		return
	}
	if strings.TrimSpace(key) == "" {
		http.Error(w, "先在设置页配置 Twelve Data Key", 409)
		return
	}
	proxy, err := proxySetting(a.db)
	if err != nil {
		fail(w, r, err)
		return
	}
	all, err := listStocks(a.db)
	if err != nil {
		fail(w, r, err)
		return
	}
	stocks := []Stock{}
	for _, s := range all {
		if s.Enabled {
			stocks = append(stocks, s)
		}
	}
	if len(stocks) == 0 {
		http.Error(w, "请先添加并启用股票", 409)
		return
	}
	id, err := createRun(a.db, stocks, "manual", 0, "", "")
	if err != nil {
		fail(w, r, err)
		return
	}
	a.runningID = id
	a.jobs.Add(1)
	go a.runOnce(id, stocks, newTwelveData(key, proxy))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "status": "running"})
}

func (a *App) runOnce(id int64, stocks []Stock, provider QuoteProvider) {
	defer a.jobs.Done()
	reason := ""
	defer func() {
		if err := a.finish(id, reason); err != nil {
			log.Printf("run %d finish: %v", id, err)
		}
		a.mu.Lock()
		a.runningID = 0
		a.mu.Unlock()
	}()
	var kind, slot string
	if err := a.db.QueryRow(`SELECT kind,slot_at FROM runs WHERE id=?`, id).Scan(&kind, &slot); err != nil {
		reason = "读取查询时段失败"
		return
	}
	var initial *QueryWindow
	var initialDay string
	if kind == "scheduled" {
		at, err := time.Parse(time.RFC3339Nano, slot)
		if err != nil {
			reason = "查询时间无效"
			return
		}
		initial, initialDay, err = a.activeWindow(at)
		if err != nil {
			reason = "读取查询时段失败"
			return
		}
	}
	canQuery := func(s Stock) (string, error) {
		if kind != "scheduled" {
			return "", nil
		}
		if initial != nil {
			current, day, err := a.activeWindow(time.Now())
			if err != nil {
				return "", err
			}
			if current == nil || current.ID != initial.ID || day != initialDay {
				return "本查询时段已结束", nil
			}
			if !current.Enabled {
				return "本查询时段已暂停", nil
			}
		}
		status, capped, err := a.windowStatus(s.ID, s.Symbol, time.Now())
		if capped {
			return status, err
		}
		return "", err
	}
	for _, s := range stocks {
		if a.ctx.Err() != nil {
			reason = "进程中断"
			return
		}
		skip, checkErr := canQuery(s)
		if checkErr != nil {
			reason = "读取时段额度失败"
			return
		}
		if skip != "" {
			if err := saveResult(a.db, id, Result{Symbol: s.Symbol, Status: "skipped", Error: skip}); err != nil {
				reason = "存储失败"
				return
			}
			continue
		}
		// Quota waiting is cancellable; each network call has its own timeout.
		err := a.reserve(a.ctx)
		var q Quote
		if err == nil {
			for attempt := 0; attempt < 2; attempt++ {
				skip, err = canQuery(s)
				if err != nil || skip != "" {
					break
				}
				ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
				q, err = provider.Fetch(ctx, s.Symbol)
				cancel()
				var limited rateLimit
				if !errors.As(err, &limited) || attempt == 1 {
					break
				}
				if e := waitRetry(a.ctx, limited.After); e != nil {
					err = e
					break
				}
				if e := a.reserve(a.ctx); e != nil {
					err = e
					break
				}
			}
		}
		if a.ctx.Err() != nil {
			reason = "进程中断"
			return
		}
		if skip != "" {
			if e := saveResult(a.db, id, Result{Symbol: s.Symbol, Status: "skipped", Error: skip}); e != nil {
				reason = "存储失败"
				return
			}
			continue
		}
		fetched := time.Now().UTC()
		v := Result{Symbol: s.Symbol, Status: "ok", FetchedAt: fetched.Format(time.RFC3339Nano), Delay: "未知"}
		if err != nil {
			v.Status = "error"
			v.Error = err.Error()
		} else {
			v.AssetOK = q.AssetOK
			v.Price = q.Price.String()
			v.Open = q.Open
			v.PrevClose = q.PrevClose
			v.QuoteAt = q.At.Format(time.RFC3339Nano)
			v.Source = q.Source
			v.TimeField = q.TimeField
			v.Delay = q.Delay
		}
		if err == nil {
			v.AlertStatus = alertValidity(q, fetched)
		}
		if e := saveResult(a.db, id, v); e != nil {
			log.Printf("run %d result persistence: %v", id, e)
			reason = "存储失败"
			return
		}
		if err == nil {
			status := ""
			var e error
			skip, e = canQuery(s)
			if e == nil && skip == "" {
				status, e = a.alert(id, s, q, fetched)
			} else {
				status = skip
			}
			if e != nil {
				log.Printf("run %d alert persistence: %v", id, e)
				reason = "通知记录存储失败"
				return
			}
			v.AlertStatus = status
			if _, e = a.db.Exec(`UPDATE results SET alert_status=? WHERE run_id=? AND symbol=?`, status, id, s.Symbol); e != nil {
				reason = "存储失败"
				return
			}
		}
	}
}
func (a *App) finish(id int64, reason string) error { return finishRun(a.db, id, reason) }
