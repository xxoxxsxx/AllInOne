package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHrefPrefixing(t *testing.T) {
	a := &App{basePath: strPtr("/stocks")}
	cases := map[string]string{
		"/":                      "/stocks/",
		"/settings":              "/stocks/settings",
		"/settings?result=saved": "/stocks/settings?result=saved",
		"/stocks/1":              "/stocks/1", // 内部路由路径（网关剥离后的形态）统一加公开前缀
		"settings":               "/stocks/settings",
	}
	for in, want := range cases {
		if got := a.href(in); got != want {
			t.Fatalf("href(%q)=%q want %q", in, got, want)
		}
	}
	empty := &App{}
	if got := empty.href("/settings"); got != "/settings" {
		t.Fatalf("empty base href=%q", got)
	}
}

func strPtr(s string) *string { return &s }

func TestWrapBaseStripsPrefix(t *testing.T) {
	a := &App{basePath: strPtr("/stocks")}
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte("path=" + r.URL.Path))
	})
	srv := httptest.NewServer(a.wrapBase(inner))
	defer srv.Close()

	// 带前缀：剥离后交给内部路由。
	resp, err := http.Get(srv.URL + "/stocks/settings")
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, resp)
	if resp.StatusCode != 200 || body != "path=/settings" {
		t.Fatalf("strip failed: %d %q", resp.StatusCode, body)
	}

	// 缺前缀的页面 GET：301 到带前缀地址。
	resp2, err := http.Get(srv.URL + "/settings")
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != 200 { // http.Get 跟随重定向后到达 /stocks/settings
		t.Fatalf("missing-prefix redirect failed: %d", resp2.StatusCode)
	}

	// /healthz 与 /static/ 不重定向，直接透传（容器健康检查依赖）。
	resp3, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp3.Body.Close()
	if resp3.StatusCode != 200 {
		t.Fatalf("healthz should pass through, got %d", resp3.StatusCode)
	}

	// POST 不做缺前缀重定向（避免 301 丢方法），直接交给内部路由处理。
	req, _ := http.NewRequest("POST", srv.URL+"/stocks", strings.NewReader("a=1"))
	resp4, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp4.Body.Close()
	if resp4.StatusCode != 200 {
		t.Fatalf("POST should pass through unwrapped, got %d", resp4.StatusCode)
	}
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	buf := make([]byte, 256)
	n, _ := resp.Body.Read(buf)
	resp.Body.Close()
	return string(buf[:n])
}

func TestValidBasePath(t *testing.T) {
	good := []string{"/stocks", "/a-b_c9", "/x"}
	bad := []string{"stocks", "/sto cks", "/a/../b", "/a?b", ""}
	for _, s := range good {
		if !validBasePath(s) {
			t.Fatalf("validBasePath(%q)=false", s)
		}
	}
	for _, s := range bad {
		if validBasePath(s) {
			t.Fatalf("validBasePath(%q)=true", s)
		}
	}
}
