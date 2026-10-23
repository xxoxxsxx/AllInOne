package main

import (
	"bytes"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestCompletionNoticesRenderAsToasts(t *testing.T) {
	render := func(t *testing.T, name string, data any) string {
		t.Helper()
		var out bytes.Buffer
		if err := pages.ExecuteTemplate(&out, name, data); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	if out := render(t, "settings", view{Notice: "配置已保存", BarkNotice: "Bark 已接受测试通知"}); strings.Count(out, "data-flash") != 2 || !strings.Contains(out, "配置已保存") {
		t.Fatal("settings notices should render with data-flash")
	}
	if out := render(t, "stock", view{UpdatedLevel: 7, Levels: []Level{{ID: 7}}}); !strings.Contains(out, `data-flash>提醒已保存。`) {
		t.Fatal("saved level notice should render with data-flash")
	}
	for _, name := range []string{"home", "stock", "schedule"} {
		if out := render(t, name, view{Notice: "股票设置已保存。"}); !strings.Contains(out, `data-flash>股票设置已保存。`) {
			t.Fatal(name + " should render its flash notice as a toast")
		}
	}
	if out := render(t, "home", view{}); strings.Contains(out, "data-flash") {
		t.Fatal("persistent home strips must stay inline")
	}
}

func TestFlashNoticeWhitelist(t *testing.T) {
	req := func(query string) *http.Request { return &http.Request{URL: &url.URL{RawQuery: query}} }
	if got := flashNotice(req("flash=level_deleted")); got != "提醒已删除。" {
		t.Fatalf("flashNotice=%q", got)
	}
	if got := flashNotice(req("flash=" + url.QueryEscape("<script>alert(1)</script>"))); got != "" {
		t.Fatalf("unknown flash codes must map to empty text, got %q", got)
	}
	if got := flashNotice(req("")); got != "" {
		t.Fatalf("empty flash must stay empty, got %q", got)
	}
}
