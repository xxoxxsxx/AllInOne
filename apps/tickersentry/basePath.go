package main

import (
	"net/http"
	"os"
	"strings"
)

// basePath 支持聚合站点子路径挂载（AllInOne PRD §6.4）：
// 公开地址是 /stocks/...，网关剥离 /stocks 前缀后应用仍按原根路径路由；
// 应用生成的链接、表单、重定向统一加回公开前缀。
// 未设置 BASE_PATH（默认）时行为与原版完全一致。

func (a *App) base() string {
	if a.basePath == nil {
		return ""
	}
	return *a.basePath
}

// href 返回带公开前缀的站内地址。
// 所有调用点传入的都是“网关剥离前缀后的内部路由”（如 /stocks/1、/settings），
// 因此无条件加前缀；不能做“已带前缀则跳过”的判断——内部路由 /stocks/*
// 与公开前缀 /stocks 重名，误判会导致详情页和表单 404。
func (a *App) href(path string) string {
	b := a.base()
	if b == "" {
		return path
	}
	if path == "/" {
		return b + "/"
	}
	if !strings.HasPrefix(path, "/") {
		return b + "/" + path
	}
	return b + path
}

// wrapBase 处理公开请求：剥离网关未剥离的前缀（或规范化缺失前缀的页面 GET）。
func (a *App) wrapBase(next http.Handler) http.Handler {
	b := a.base()
	if b == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p := r.URL.Path; p == b || strings.HasPrefix(p, b+"/") {
			r2 := r.Clone(r.Context())
			var rest string
			if p == b {
				rest = "/"
			} else {
				rest = strings.TrimPrefix(p, b)
			}
			r2.URL.Path = rest
			r2.URL.RawPath = ""
			next.ServeHTTP(w, r2)
			return
		}
		// 前缀缺失：仅页面 GET/HEAD 安全重定向到带前缀地址（PRD §6.4 第 6 条）。
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			path := r.URL.Path
			// /static/ 与 /healthz 不重定向：容器健康检查与模板资源始终按根路径可达。
			if !strings.HasPrefix(path, "/static/") && path != "/healthz" {
				target := a.href(path)
				if r.URL.RawQuery != "" {
					target += "?" + r.URL.RawQuery
				}
				http.Redirect(w, r, target, http.StatusMovedPermanently)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// portalURL 返回门户地址（PORTAL_URL 环境变量），用于公共导航“返回工具箱”。
func portalURL() string {
	return strings.TrimRight(strings.TrimSpace(os.Getenv("PORTAL_URL")), "/")
}
