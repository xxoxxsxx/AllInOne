package main

import (
	"github.com/shopspring/decimal"
	"strings"
	"time"
)

func targetGap(side, target, price string) string {
	p, err := decimal.NewFromString(price)
	if err != nil || !p.IsPositive() {
		return "暂无报价，无法计算差距"
	}
	t, err := decimal.NewFromString(target)
	if err != nil {
		return "目标价无效"
	}
	if side == "buy" && p.LessThanOrEqual(t) || side == "sell" && p.GreaterThanOrEqual(t) {
		return "报价已达目标（不代表已通知）"
	}
	diff := t.Sub(p).Abs()
	direction := "上涨"
	if side == "buy" {
		direction = "下跌"
	}
	return "还需" + direction + " " + diff.StringFixed(2) + " USD（" + diff.Div(p).Mul(decimal.NewFromInt(100)).StringFixed(2) + "%）"
}

func quoteReadiness(s Stock) string {
	if !s.Enabled {
		return "股票已暂停"
	}
	if s.LastPrice == "" {
		return "尚无有效报价"
	}
	if s.LastStatus != "ok" {
		return "最新查询未成功；下方差距沿用旧报价"
	}
	at, err := time.Parse(time.RFC3339Nano, s.LastAt)
	if err != nil {
		return "行情时间无效"
	}
	why := alertValidity(Quote{At: at, TimeField: s.TimeField, AssetOK: s.AssetOK}, time.Now())
	if why != "" {
		return why
	}
	return "最近报价符合触价条件；实际通知取决于档位状态和各渠道发送结果"
}

func (a *App) readiness(key, scheduled bool) ([]string, error) {
	c, err := notificationSettings(a.db)
	if err != nil {
		return nil, err
	}
	out := []string{}
	out = append(out, "触价通知：自动查询和手动查询均会在有效报价命中时发送到所有已启用渠道")
	if key {
		out = append(out, "行情 Key：已配置，查询成功后才能判断报价有效性")
	} else {
		out = append(out, "行情 Key：未配置，无法查询")
	}
	if names := c.enabled(); len(names) > 0 {
		out = append(out, "通知渠道："+strings.Join(names, "、")+" 已启用；实际送达请在接收端确认")
	} else {
		out = append(out, "通知渠道：无启用且配置完整的渠道，命中后无法发送通知")
	}
	if scheduled {
		out = append(out, "自动查询时间：已配置")
	} else {
		out = append(out, "自动查询时间：未启用，请先设置查询时间")
	}
	if !calendarReviewed(time.Now()) {
		out = append(out, "交易日历：超出核验范围，停止触价")
	} else if !nyse.IsOpen(time.Now()) {
		out = append(out, "市场：当前休市，查询报价不会触价")
	} else {
		out = append(out, "市场：常规交易时段")
	}
	return out, nil
}
