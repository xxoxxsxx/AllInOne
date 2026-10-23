package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/shopspring/decimal"
)

type Quote struct {
	Symbol    string
	Price     decimal.Decimal
	Open      string
	PrevClose string
	At        time.Time
	Source    string
	TimeField string
	Delay     string
	AssetOK   bool
}

type QuoteProvider interface {
	Fetch(context.Context, string) (Quote, error)
}

type rateLimit struct{ After time.Duration }

func (e rateLimit) Error() string { return "行情服务限流 (429)" }

type twelveData struct {
	key    string
	client *http.Client
}

func newTwelveData(key, proxy string) QuoteProvider {
	return &twelveData{key: key, client: outboundClient(12*time.Second, proxy)}
}

func (p *twelveData) Fetch(ctx context.Context, symbol string) (Quote, error) {
	endpoint := "https://api.twelvedata.com/quote?" + url.Values{"symbol": {symbol}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Quote{}, err
	}
	// Do not put the key in URLs: URLs can be recorded by proxies and error logs.
	req.Header.Set("Authorization", "apikey "+p.key)
	resp, err := p.client.Do(req)
	if err != nil {
		return Quote{}, errors.New("行情服务连接失败或超时")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		return Quote{}, rateLimit{After: retryDelay(resp.Header.Get("Retry-After"))}
	}
	if resp.StatusCode != http.StatusOK {
		return Quote{}, fmt.Errorf("行情服务 HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return Quote{}, errors.New("读取行情响应失败")
	}
	var raw struct {
		Status      string `json:"status"`
		Code        int    `json:"code"`
		Message     string `json:"message"`
		Symbol      string `json:"symbol"`
		Currency    string `json:"currency"`
		Open        string `json:"open"`
		Close       string `json:"close"`
		PrevClose   string `json:"previous_close"`
		LastUpdate  string `json:"last_update_at"`
		LastQuoteAt int64  `json:"last_quote_at"`
		Exchange    string `json:"exchange"`
		MICCode     string `json:"mic_code"`
		Type        string `json:"type"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return Quote{}, errors.New("行情响应不是有效 JSON")
	}
	if raw.Status == "error" && raw.Code == 429 {
		return Quote{}, rateLimit{After: retryDelay(resp.Header.Get("Retry-After"))}
	}
	if raw.Status == "error" {
		return Quote{}, errors.New("行情服务拒绝请求：请检查代码、Key 或额度")
	}
	if !strings.EqualFold(raw.Symbol, symbol) {
		return Quote{}, errors.New("行情代码与请求不匹配")
	}
	if raw.Currency != "USD" {
		return Quote{}, errors.New("行情币种不是 USD")
	}
	if raw.Close == "" {
		return Quote{}, errors.New("行情缺少价格")
	}
	price, err := decimal.NewFromString(raw.Close)
	if err != nil || !price.IsPositive() {
		return Quote{}, errors.New("行情价格无效")
	}
	open := ""
	if opening, err := decimal.NewFromString(raw.Open); err == nil && opening.IsPositive() {
		open = opening.String()
	}
	prevClose := ""
	if previous, err := decimal.NewFromString(raw.PrevClose); err == nil && previous.IsPositive() {
		prevClose = previous.String()
	}
	var at time.Time
	field := "last_update_at"
	if raw.LastUpdate != "" {
		at, err = time.Parse(time.RFC3339, raw.LastUpdate)
		if err != nil {
			return Quote{}, errors.New("行情更新时间格式或时区无效")
		}
	} else if raw.LastQuoteAt > 0 {
		// Official /quote responses use last_quote_at for the latest minute candle.
		at = time.Unix(raw.LastQuoteAt, 0).UTC()
		field = "last_quote_at"
	} else {
		return Quote{}, errors.New("行情缺少可信更新时间；不可用区间起点 timestamp 代替")
	}
	if at.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) {
		return Quote{}, errors.New("行情更新时间无效")
	}
	if at.After(time.Now().Add(2 * time.Minute)) {
		return Quote{}, errors.New("行情更新时间在未来")
	}
	asset := raw.Type == "" || strings.EqualFold(raw.Type, "Common Stock") || strings.EqualFold(raw.Type, "ETF")
	exchange := strings.ToUpper(strings.TrimSpace(raw.Exchange))
	usExchange := exchange == "NASDAQ" || exchange == "NYSE" || exchange == "NYSE ARCA" || exchange == "AMEX" || exchange == "NYSE MKT" || exchange == "CBOE" || exchange == "BATS"
	mic := strings.ToUpper(strings.TrimSpace(raw.MICCode))
	// Nasdaq quotes may identify the Global Select, Global or Capital Market segment.
	usMIC := mic == "" || mic == "XNGS" || mic == "XNMS" || mic == "XNCM" || mic == "XNAS" || mic == "XNYS" || mic == "ARCX" || mic == "XASE" || mic == "BATS" || mic == "EDGX"
	return Quote{Symbol: symbol, Price: price, Open: open, PrevClose: prevClose, At: at.UTC(), Source: "Twelve Data", TimeField: field, Delay: "未知", AssetOK: asset && usExchange && usMIC}, nil
}
