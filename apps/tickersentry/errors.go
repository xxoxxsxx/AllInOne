package main

import (
	"log"
	"net/http"
	"strings"
)

// respondError 包级入口：供无法拿到 App 的场景（仅 errors.go 内部）。
func respondError(w http.ResponseWriter, r *http.Request, status int, msg string) {
	respondErrorView(w, r, status, msg, view{})
}

// respondError 是 App 方法：错误页面带公共导航字段（Base/PortalURL）。
func (a *App) respondError(w http.ResponseWriter, r *http.Request, status int, msg string) {
	respondErrorView(w, r, status, msg, view{Base: a.base(), PortalURL: portalURL()})
}

func respondErrorView(w http.ResponseWriter, r *http.Request, status int, msg string, base view) {
	// Query APIs are consumed by fetch; notification test endpoints are browser forms.
	if r.Header.Get("Accept") == "application/json" || r.URL.Path == "/api/runs" || strings.HasPrefix(r.URL.Path, "/api/runs/") {
		http.Error(w, msg, status)
		return
	}
	title := "操作未完成"
	switch status {
	case 403:
		title = "请重新打开页面"
	case 404:
		title = "找不到这个页面"
	case 500:
		title = "服务暂时遇到问题"
	case 502:
		title = "通知发送失败"
		if strings.Contains(msg, "代理测试失败") {
			title = "代理连接失败"
		}
	}
	base.Title = title
	base.Error = msg
	base.StatusCode = status
	renderStatus(w, "error", base, status)
}

func formError(w http.ResponseWriter, r *http.Request, msg string) {
	respondError(w, r, http.StatusBadRequest, msg)
}

func fail(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("storage error: %v", err)
	respondError(w, r, 500, "操作失败，请稍后重试。如果仍无法完成，请检查服务日志。")
}

// App 方法版本：错误页带公共导航字段。
func (a *App) formError(w http.ResponseWriter, r *http.Request, msg string) {
	a.respondError(w, r, http.StatusBadRequest, msg)
}

func (a *App) fail(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("storage error: %v", err)
	a.respondError(w, r, 500, "操作失败，请稍后重试。如果仍无法完成，请检查服务日志。")
}

func renderStatus(w http.ResponseWriter, name string, v view, status int) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	render(w, name, v)
}
