package main

import (
	"bytes"
	"strings"
	"testing"
)

// 渲染冒烟：Base 前缀必须正确出现在所有出站链接上，门户链接保持根路径。
// 注意内部路由 /stocks/* 与公开前缀重名，公开地址必须是 /stocks/stocks/...。
func TestRenderScheduleSmoke(t *testing.T) {
	v := view{Title: "t", Base: "/stocks", PortalURL: "/", Schedules: []Schedule{{ID: 1, Enabled: true}}, Windows: []QueryWindow{{ID: 2, Enabled: false}}, Timezone: "UTC"}
	var out bytes.Buffer
	if err := pages.ExecuteTemplate(&out, "schedule", v); err != nil {
		t.Fatal(err)
	}
	s := out.String()
	must := []string{
		`data-base="/stocks"`,
		`href="/stocks/" aria-label="TickerSentry 首页"`,
		`href="/">工具箱</a>`,
		`href="/stocks/schedule"`,
		`href="/stocks/settings"`,
		`/stocks/static/app.css`,
		`action="/stocks/windows"`,
		`action="/stocks/windows/2/enable"`,
		`action="/stocks/schedule/1/disable"`,
		`action="/stocks/schedule/zone"`,
	}
	for _, want := range must {
		if !strings.Contains(s, want) {
			t.Fatalf("schedule 缺少 %s", want)
		}
	}
	for _, bad := range []string{`href="/schedule"`, `href="/settings"`, `action="/windows"`, `action="/schedule"`, `src="/static/`} {
		if strings.Contains(s, bad) {
			t.Fatalf("schedule 存在未加前缀的链接 %s", bad)
		}
	}
}

func TestRenderHomeSmoke(t *testing.T) {
	v := view{
		Title: "t", Base: "/stocks", PortalURL: "/", CSRF: "tok", Timezone: "UTC",
		Stocks:       []Stock{{ID: 1, Symbol: "AAPL", Enabled: true}},
		ActiveStocks: 1,
	}
	var out bytes.Buffer
	if err := pages.ExecuteTemplate(&out, "home", v); err != nil {
		t.Fatal(err)
	}
	s := out.String()
	must := []string{
		// 股票详情、添加股票表单：内部 /stocks/* 必须输出 /stocks/stocks/*。
		`href="/stocks/stocks/1"`,
		`action="/stocks/stocks"`,
		`href="/">工具箱</a>`,
	}
	for _, want := range must {
		if !strings.Contains(s, want) {
			t.Fatalf("home 缺少 %s", want)
		}
	}
	if strings.Contains(s, `href="/stocks/1"`) || strings.Contains(s, `action="/stocks"`+`" id="add-stock-form"`) {
		t.Fatalf("home 存在漏加前缀的股票链接")
	}
}
