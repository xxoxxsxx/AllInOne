package main

import (
	"bytes"
	"strings"
	"testing"
)

// 渲染冒烟：Base 前缀必须正确出现在所有出站链接上，门户链接保持根路径。
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
			t.Fatalf("缺少 %s", want)
		}
	}
	// 不应出现未加前缀的业务链接（门户链接 "/" 除外）。
	for _, bad := range []string{`href="/schedule"`, `href="/settings"`, `action="/windows"`, `action="/schedule"`, `src="/static/`} {
		if strings.Contains(s, bad) {
			t.Fatalf("存在未加前缀的链接 %s", bad)
		}
	}
}
