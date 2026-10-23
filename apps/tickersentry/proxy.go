package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func checkProxy(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 256 || (u.Scheme != "http" && u.Scheme != "socks5") || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("代理地址须为 HTTP 或 SOCKS5 的地址和端口，不支持账号密码")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return "", errors.New("代理端口须为 1～65535")
	}
	return u.String(), nil
}

func proxySetting(db *sql.DB) (string, error) {
	return value(db, `SELECT proxy_url FROM settings WHERE id=1`)
}

var directTransport = func() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return transport
}()

func outboundClient(timeout time.Duration, proxy string) *http.Client {
	client := &http.Client{Timeout: timeout, Transport: directTransport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if proxy != "" {
		u, _ := url.Parse(proxy) // Saved proxy URLs are validated before use.
		transport := directTransport.Clone()
		transport.Proxy = http.ProxyURL(u)
		client.Transport = transport
	}
	return client
}

func testProxy(ctx context.Context, proxy string) (string, error) {
	client := outboundClient(7*time.Second, proxy)
	if transport, ok := client.Transport.(*http.Transport); ok {
		defer transport.CloseIdleConnections()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.telegram.org/bot0:invalid/getMe", nil)
	if err != nil {
		return "", errors.New("代理测试请求无效")
	}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			return "", errors.New("代理连接超时；检查软路由地址、端口、允许局域网连接及分流规则")
		}
		return "", errors.New("代理无法访问外网；检查软路由地址、端口、允许局域网连接及分流规则")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		return "", fmt.Errorf("Telegram 连通性检查返回 HTTP %d", resp.StatusCode)
	}
	return strconv.FormatInt(time.Since(start).Milliseconds(), 10), nil
}
