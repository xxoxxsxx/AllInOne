package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

func levelFields(r *http.Request) (string, string, string, int, error) {
	side := r.PostForm.Get("side")
	if side != "buy" && side != "sell" {
		return "", "", "", 0, errors.New("方向无效")
	}
	target, err := parseTarget(r.PostForm.Get("target"))
	if err != nil {
		return "", "", "", 0, err
	}
	note := strings.TrimSpace(r.PostForm.Get("note"))
	if len(note) > 200 {
		return "", "", "", 0, errors.New("备注过长")
	}
	limit := 0
	if text := strings.TrimSpace(r.PostForm.Get("max_alerts")); text != "" {
		limit, err = strconv.Atoi(text)
		if err != nil || limit < 1 || limit > 1000 {
			return "", "", "", 0, errors.New("档位提醒上限须为 1～1000 次，或留空继承时段默认值")
		}
	}
	return side, target, note, limit, nil
}
func (a *App) stockID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		a.formError(w, r, "编号无效")
		return 0, false
	}
	if _, err = getStock(a.db, id); errors.Is(err, sql.ErrNoRows) {
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
		return 0, false
	} else if err != nil {
		a.fail(w, r, err)
		return 0, false
	}
	return id, true
}
func levelID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("level"), 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.New("档位编号无效")
	}
	return id, nil
}
func (a *App) levelAdd(w http.ResponseWriter, r *http.Request) {
	id, ok := a.stockID(w, r)
	if !ok {
		return
	}
	side, target, note, limit, err := levelFields(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	if _, err = a.db.Exec(`INSERT INTO levels(stock_id,side,target,note,max_alerts,uid) VALUES(?,?,?,?,?,lower(hex(randomblob(16))))`, id, side, target, note, limit); err != nil {
		a.fail(w, r, err)
		return
	}
	http.Redirect(w, r, fmt.Sprintf(a.href("/stocks/%d?flash=level_added#add-level"), id), 303)
}
func (a *App) levelUpdate(w http.ResponseWriter, r *http.Request) {
	id, ok := a.stockID(w, r)
	if !ok {
		return
	}
	level, err := levelID(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	side, target, note, limit, err := levelFields(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	res, err := a.db.Exec(`UPDATE levels SET side=?,target=?,note=?,max_alerts=? WHERE id=? AND stock_id=?`, side, target, note, limit, level, id)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
		return
	}
	http.Redirect(w, r, fmt.Sprintf(a.href("/stocks/%d?updated=%d#level-%d"), id, level, level), 303)
}
func (a *App) levelAction(w http.ResponseWriter, r *http.Request) {
	id, ok := a.stockID(w, r)
	if !ok {
		return
	}
	level, err := levelID(r)
	if err != nil {
		a.formError(w, r, err.Error())
		return
	}
	action := r.PathValue("action")
	var query, flash string
	switch action {
	case "pause":
		query, flash = `UPDATE levels SET enabled=0 WHERE id=? AND stock_id=?`, "level_paused"
	case "enable":
		query, flash = `UPDATE levels SET enabled=1 WHERE id=? AND stock_id=?`, "level_enabled"
	case "rearm":
		query, flash = `UPDATE levels SET enabled=1,generation=generation+1,alerted_generation=NULL,last_attempt='' WHERE id=? AND stock_id=?`, "level_rearmed"
	case "delete":
		query, flash = `DELETE FROM levels WHERE id=? AND stock_id=?`, "level_deleted"
	default:
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
		return
	}
	res, err := a.db.Exec(query, level, id)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		a.respondError(w, r, 404, "页面或记录不存在，可能已被删除。")
		return
	}
	http.Redirect(w, r, fmt.Sprintf(a.href("/stocks/%d?flash=%s#price-levels"), id, flash), 303)
}
func (a *App) barkTest(w http.ResponseWriter, r *http.Request) {
	c, err := notificationSettings(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if c.Bark.URL == "" || c.Bark.Key == "" {
		a.formError(w, r, "请先配置 Bark 地址和设备 Key")
		return
	}
	status, err := c.send(r.Context(), "Bark", "TickerSentry 测试通知", "测试推送，不涉及股价")
	if err != nil {
		a.respondError(w, r, 502, status+"："+err.Error())
		return
	}
	http.Redirect(w, r, a.href("/settings?tested=bark"), 303)
}

func (a *App) feishuTest(w http.ResponseWriter, r *http.Request) {
	c, err := notificationSettings(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if c.FeishuWebhook == "" {
		a.formError(w, r, "请先配置飞书 Webhook")
		return
	}
	status, err := c.send(r.Context(), "飞书", "TickerSentry 测试通知", "测试推送，不涉及股价")
	if err != nil {
		a.respondError(w, r, 502, status+"："+err.Error())
		return
	}
	http.Redirect(w, r, a.href("/settings?tested=feishu"), 303)
}

func (a *App) telegramTest(w http.ResponseWriter, r *http.Request) {
	c, err := notificationSettings(a.db)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if c.TGToken == "" || c.TGChatID == "" {
		a.formError(w, r, "请先配置 Telegram Bot Token 和 Chat ID")
		return
	}
	status, err := c.send(r.Context(), "Telegram", "TickerSentry 测试通知", "测试推送，不涉及股价")
	if err != nil {
		a.respondError(w, r, 502, status+"："+err.Error())
		return
	}
	http.Redirect(w, r, a.href("/settings?tested=telegram"), 303)
}
