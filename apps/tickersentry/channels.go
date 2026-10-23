package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type channelConfig struct {
	Bark                            barkConfig
	BarkEnabled                     bool
	FeishuWebhook, FeishuSecret     string
	FeishuEnabled                   bool
	TGToken, TGChatID               string
	TGEnabled                       bool
	Proxy                           string
	BarkProxy, FeishuProxy, TGProxy bool
}

type channelResult struct {
	Name, Status, Error string
}

var tgTokenPattern = regexp.MustCompile(`^[0-9]{5,15}:[A-Za-z0-9_-]{20,100}$`)
var tgChatPattern = regexp.MustCompile(`^-?[0-9]{1,20}$`)
var feishuHookPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

func checkFeishuWebhook(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if len(raw) > 512 || err != nil || u.Scheme != "https" || u.Host != "open.feishu.cn" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !strings.HasPrefix(u.Path, "/open-apis/bot/v2/hook/") || !feishuHookPattern.MatchString(strings.TrimPrefix(u.Path, "/open-apis/bot/v2/hook/")) {
		return "", errors.New("飞书 Webhook 须为 open.feishu.cn 的群自定义机器人地址")
	}
	return raw, nil
}

func checkTG(token, chat string) error {
	if !tgTokenPattern.MatchString(token) || !tgChatPattern.MatchString(chat) {
		return errors.New("Telegram Bot Token 或数字 Chat ID 格式无效")
	}
	return nil
}

func notificationSettings(db *sql.DB) (channelConfig, error) {
	var c channelConfig
	err := db.QueryRow(`SELECT bark_url,bark_key,bark_local,bark_enabled,feishu_webhook,feishu_secret,feishu_enabled,tg_token,tg_chat_id,tg_enabled,proxy_url,bark_proxy,feishu_proxy,tg_proxy FROM settings WHERE id=1`).Scan(&c.Bark.URL, &c.Bark.Key, &c.Bark.Local, &c.BarkEnabled, &c.FeishuWebhook, &c.FeishuSecret, &c.FeishuEnabled, &c.TGToken, &c.TGChatID, &c.TGEnabled, &c.Proxy, &c.BarkProxy, &c.FeishuProxy, &c.TGProxy)
	return c, err
}

func (c channelConfig) channelProxy(use bool) string {
	if use {
		return c.Proxy
	}
	return ""
}

func (c channelConfig) enabled() []string {
	var names []string
	if c.BarkEnabled && c.Bark.URL != "" && c.Bark.Key != "" {
		names = append(names, "Bark")
	}
	if c.FeishuEnabled && c.FeishuWebhook != "" {
		names = append(names, "飞书")
	}
	if c.TGEnabled && c.TGToken != "" && c.TGChatID != "" {
		names = append(names, "Telegram")
	}
	return names
}

func postJSON(ctx context.Context, endpoint string, payload any, channel, proxy string) (*http.Response, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(data))
	if err != nil {
		return nil, errors.New(channel + " 请求无效")
	}
	req.Header.Set("Content-Type", "application/json")
	client := outboundClient(10*time.Second, proxy)
	return client.Do(req)
}

func sendFeishu(ctx context.Context, webhook, secret, text, proxy string) (string, error) {
	payload := map[string]any{"msg_type": "text", "content": map[string]string{"text": text}}
	if secret != "" {
		timestamp := fmt.Sprint(time.Now().Unix())
		mac := hmac.New(sha256.New, []byte(timestamp+"\n"+secret))
		payload["timestamp"] = timestamp
		payload["sign"] = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	}
	resp, err := postJSON(ctx, webhook, payload, "飞书", proxy)
	if err != nil {
		return "不确定", errors.New("飞书网络异常或超时，发送结果不确定")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "失败", fmt.Errorf("飞书 HTTP %d", resp.StatusCode)
	}
	var result struct {
		Code       *int `json:"code"`
		StatusCode *int `json:"StatusCode"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&result) != nil {
		return "不确定", errors.New("飞书响应无法确认")
	}
	if result.Code == nil && result.StatusCode == nil {
		return "不确定", errors.New("飞书响应无法确认")
	}
	if result.Code != nil && *result.Code != 0 {
		return "失败", fmt.Errorf("飞书拒绝请求 (code %d)", *result.Code)
	}
	if result.StatusCode != nil && *result.StatusCode != 0 {
		return "失败", fmt.Errorf("飞书拒绝请求 (code %d)", *result.StatusCode)
	}
	return "成功", nil
}

func sendTelegram(ctx context.Context, token, chat, text, proxy string) (string, error) {
	resp, err := postJSON(ctx, "https://api.telegram.org/bot"+token+"/sendMessage", map[string]string{"chat_id": chat, "text": text}, "Telegram", proxy)
	if err != nil {
		var dns *net.DNSError
		var op *net.OpError
		var timeout net.Error
		var unknownCA x509.UnknownAuthorityError
		var invalidCert x509.CertificateInvalidError
		var hostname x509.HostnameError
		switch {
		case errors.As(err, &dns):
			return "失败", errors.New("Telegram 域名解析失败；请检查 NAS 的 DNS 和容器网络")
		case errors.As(err, &op) && op.Op == "dial":
			return "失败", errors.New("Telegram 连接失败；请检查 NAS 到 api.telegram.org:443 的连通性及代理配置")
		case errors.As(err, &unknownCA) || errors.As(err, &invalidCert) || errors.As(err, &hostname):
			return "失败", errors.New("Telegram HTTPS 证书校验失败；请检查 NAS 时间、代理和证书配置")
		case errors.Is(err, context.DeadlineExceeded) || errors.As(err, &timeout) && timeout.Timeout():
			return "不确定", errors.New("Telegram 请求超时；请先到接收会话核对是否送达，再检查 NAS 到 api.telegram.org:443 的连通性")
		default:
			return "不确定", errors.New("Telegram 网络请求中断，发送结果不确定；请先到接收会话核对，再检查 NAS 容器网络")
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		switch resp.StatusCode {
		case http.StatusBadRequest:
			return "失败", errors.New("Telegram 拒绝请求 (HTTP 400)；请核对 Chat ID 和目标会话")
		case http.StatusUnauthorized, http.StatusNotFound:
			return "失败", fmt.Errorf("Telegram 拒绝请求 (HTTP %d)；请核对 Bot Token", resp.StatusCode)
		case http.StatusForbidden:
			return "失败", errors.New("Telegram 拒绝请求 (HTTP 403)；请在目标会话启动 Bot，或检查群内发送权限")
		case http.StatusTooManyRequests:
			return "失败", errors.New("Telegram 请求过于频繁 (HTTP 429)；请稍后重试")
		default:
			return "失败", fmt.Errorf("Telegram 拒绝请求 (HTTP %d)", resp.StatusCode)
		}
	}
	var result struct {
		OK bool `json:"ok"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&result) != nil {
		return "不确定", errors.New("Telegram 响应无法确认")
	}
	if !result.OK {
		return "失败", errors.New("Telegram 拒绝请求")
	}
	return "成功", nil
}

func (c channelConfig) send(ctx context.Context, name, title, body string) (string, error) {
	switch name {
	case "Bark":
		return sendBark(ctx, c.Bark, title, body, c.channelProxy(c.BarkProxy))
	case "飞书":
		return sendFeishu(ctx, c.FeishuWebhook, c.FeishuSecret, title+"\n"+body, c.channelProxy(c.FeishuProxy))
	case "Telegram":
		return sendTelegram(ctx, c.TGToken, c.TGChatID, title+"\n"+body, c.channelProxy(c.TGProxy))
	}
	return "失败", errors.New("通知渠道无效")
}

func channelStatus(results []channelResult) string {
	success, uncertain := 0, 0
	for _, r := range results {
		if r.Status == "成功" {
			success++
		}
		if r.Status == "不确定" || r.Status == "发送中" {
			uncertain++
		}
	}
	if success == len(results) {
		return "成功"
	}
	if success > 0 {
		return "部分成功"
	}
	if uncertain > 0 {
		return "不确定"
	}
	return "失败"
}
