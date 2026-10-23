package main

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/shopspring/decimal"
)

type Level struct {
	ID, StockID, Generation int64
	Side, Target, Note, UID string
	Enabled                 bool
	AlertedGeneration       sql.NullInt64
	State                   string
	Mode                    string
	Cooldown                int
	LastAttempt             string
	Profit                  string
	Gap                     string
	MaxAlerts, Used, Limit  int
	WindowActive            bool
}

func (l Level) alertLimit(w *QueryWindow) int {
	if l.MaxAlerts > 0 {
		return l.MaxAlerts
	}
	return w.MaxAlerts
}

type Notification struct {
	ID, RunID                                                int64
	Symbol, Price, QuoteAt, Levels, Status, Error, CreatedAt string
	Channels                                                 []channelResult
}

func listLevels(db *sql.DB, stockID int64) ([]Level, error) {
	rows, err := db.Query(`SELECT id,stock_id,side,target,note,enabled,generation,alerted_generation,mode,cooldown,last_attempt,max_alerts,uid FROM levels WHERE stock_id=? ORDER BY id`, stockID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Level{}
	for rows.Next() {
		var l Level
		if err := rows.Scan(&l.ID, &l.StockID, &l.Side, &l.Target, &l.Note, &l.Enabled, &l.Generation, &l.AlertedGeneration, &l.Mode, &l.Cooldown, &l.LastAttempt, &l.MaxAlerts, &l.UID); err != nil {
			return nil, err
		}
		if !l.Enabled {
			l.State = "已暂停"
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func listNotifications(db *sql.DB, symbol string) ([]Notification, error) {
	rows, err := db.Query(`SELECT id,run_id,symbol,price,quote_at,levels,status,error,created_at FROM notifications WHERE symbol=? ORDER BY id DESC LIMIT 30`, symbol)
	if err != nil {
		return nil, err
	}
	out := []Notification{}
	for rows.Next() {
		var n Notification
		if err := rows.Scan(&n.ID, &n.RunID, &n.Symbol, &n.Price, &n.QuoteAt, &n.Levels, &n.Status, &n.Error, &n.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, n)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	channels, err := db.Query(`SELECT notification_id,channel,status,error FROM notification_channels WHERE notification_id IN (SELECT id FROM notifications WHERE symbol=? ORDER BY id DESC LIMIT 30) ORDER BY notification_id DESC,channel`, symbol)
	if err != nil {
		return nil, err
	}
	defer channels.Close()
	byID := make(map[int64]*Notification, len(out))
	for i := range out {
		byID[out[i].ID] = &out[i]
	}
	for channels.Next() {
		var id int64
		var c channelResult
		if err := channels.Scan(&id, &c.Name, &c.Status, &c.Error); err != nil {
			return nil, err
		}
		if n := byID[id]; n != nil {
			n.Channels = append(n.Channels, c)
		}
	}
	if err := channels.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if len(out[i].Channels) == 0 && !strings.HasPrefix(out[i].Status, "命中但未通知") {
			out[i].Channels = []channelResult{{Name: "Bark", Status: out[i].Status, Error: out[i].Error}}
		}
	}
	return out, nil
}

func parseTarget(input string) (string, error) {
	input = strings.TrimSpace(input)
	if len(input) == 0 || len(input) > 32 || strings.ContainsAny(input, "eE") {
		return "", errors.New("目标价必须是正数，最多 4 位小数")
	}
	d, err := decimal.NewFromString(input)
	if err != nil || !d.IsPositive() || d.Exponent() < -4 || d.GreaterThan(decimal.RequireFromString("1000000000")) {
		return "", errors.New("目标价必须是正数，最多 4 位小数且小于十亿")
	}
	return d.String(), nil
}

func dueLevels(db *sql.DB, stockID int64, price decimal.Decimal) ([]Level, error) {
	levels, err := listLevels(db, stockID)
	if err != nil {
		return nil, err
	}
	var buy, sell *Level
	for _, l := range levels {
		if !l.Enabled {
			continue
		}
		d, err := decimal.NewFromString(l.Target)
		if err != nil {
			return nil, fmt.Errorf("档位价格无效: %w", err)
		}
		hit := l.Side == "buy" && price.LessThanOrEqual(d) || l.Side == "sell" && price.GreaterThanOrEqual(d)
		if hit && l.Side == "buy" && (buy == nil || d.LessThan(decimal.RequireFromString(buy.Target))) {
			picked := l
			buy = &picked
		} else if hit && l.Side == "sell" && (sell == nil || d.GreaterThan(decimal.RequireFromString(sell.Target))) {
			picked := l
			sell = &picked
		}
	}
	due := []Level{}
	if buy != nil {
		due = append(due, *buy)
	}
	if sell != nil {
		due = append(due, *sell)
	}
	return due, nil
}

// Load homepage prices in one query, regardless of the number of stocks.
func homeLevels(db *sql.DB, stocks []Stock) error {
	byID := make(map[int64]*Stock, len(stocks))
	for i := range stocks {
		byID[stocks[i].ID] = &stocks[i]
	}
	rows, err := db.Query(`SELECT id,stock_id,side,target,enabled,
		CASE WHEN enabled=0 THEN '已暂停' ELSE '' END,mode,cooldown,last_attempt,max_alerts,uid
		FROM levels ORDER BY stock_id,CAST(target AS NUMERIC),id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var l Level
		if err := rows.Scan(&l.ID, &l.StockID, &l.Side, &l.Target, &l.Enabled, &l.State, &l.Mode, &l.Cooldown, &l.LastAttempt, &l.MaxAlerts, &l.UID); err != nil {
			return err
		}
		stock := byID[l.StockID]
		if stock == nil {
			continue
		}
		l.Gap = targetGap(l.Side, l.Target, stock.LastPrice)
		if l.Side == "buy" {
			stock.BuyLevels = append(stock.BuyLevels, l)
		} else {
			stock.SellLevels = append(stock.SellLevels, l)
		}
	}
	for i := range stocks {
		stocks[i].setReturns()
	}
	return rows.Err()
}

// Estimates use a selected target, never an assumed executed trade.
func (s *Stock) setReturns() {
	for _, l := range s.BuyLevels {
		if l.Target == s.ReferenceBuy {
			s.BuyBasis = l.Target
			break
		}
		if s.BuyBasis == "" || decimal.RequireFromString(l.Target).GreaterThan(decimal.RequireFromString(s.BuyBasis)) {
			s.BuyBasis = l.Target
		}
	}
	for i := range s.SellLevels {
		s.SellLevels[i].Profit = expectedReturn(s.BuyBasis, s.SellLevels[i].Target)
	}
}
func expectedReturn(buy, sell string) string {
	b, err := decimal.NewFromString(buy)
	if err != nil || !b.IsPositive() {
		return "设置买入价后查看预计收益"
	}
	p, err := decimal.NewFromString(sell)
	if err != nil {
		return ""
	}
	delta := p.Sub(b)
	sign := ""
	if delta.IsPositive() {
		sign = "+"
	}
	return fmt.Sprintf("每股 %s%s USD · %s%s%%", sign, delta.StringFixed(2), sign, delta.Div(b).Mul(decimal.NewFromInt(100)).StringFixed(2))
}
