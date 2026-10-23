package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

type priceTransport func(*http.Request) (*http.Response, error)

func (f priceTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestOpeningPriceParsing(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{{`"101.2300"`, "101.23"}, {`""`, ""}, {`null`, ""}, {`"invalid"`, ""}, {`"0"`, ""}, {`"-1"`, ""}} {
		t.Run(tc.raw, func(t *testing.T) {
			p := &twelveData{client: &http.Client{Transport: priceTransport(func(*http.Request) (*http.Response, error) {
				body := fmt.Sprintf(`{"symbol":"AAPL","currency":"USD","open":%s,"close":"103","previous_close":"100","last_update_at":"2026-01-02T15:00:00Z","exchange":"NASDAQ"}`, tc.raw)
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}}
			q, err := p.Fetch(context.Background(), "AAPL")
			if err != nil || q.Open != tc.want || q.Price.String() != "103" || q.PrevClose != "100" {
				t.Fatalf("quote=%+v err=%v", q, err)
			}
		})
	}
}

func TestPricePersistenceAndViews(t *testing.T) {
	db, err := openDB(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// Exercise both supported legacy versions without modifying any real database.
	for _, version := range []int{17, 18} {
		if _, err := db.Exec(fmt.Sprintf(`ALTER TABLE results DROP COLUMN open; PRAGMA user_version=%d`, version)); err != nil {
			t.Fatal(err)
		}
		if err := migrate(db); err != nil {
			t.Fatal(err)
		}
		if err := migrate(db); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO stocks(symbol) VALUES('AAPL')`); err != nil {
		t.Fatal(err)
	}
	id, err := createRun(db, []Stock{{Symbol: "AAPL"}}, "manual", 0, "", "")
	if err != nil {
		t.Fatal(err)
	}
	result := Result{Symbol: "AAPL", Price: "103", Open: "101.23", PrevClose: "100", Status: "ok"}
	if err := saveResult(db, id, result); err != nil {
		t.Fatal(err)
	}
	stocks, err := listStocks(db)
	if err != nil || len(stocks) != 1 {
		t.Fatalf("stocks=%v err=%v", stocks, err)
	}
	if stocks[0].Open != result.Open || stocks[0].PrevClose != result.PrevClose {
		t.Fatal(stocks[0])
	}
	quotes, err := listStockQuotes(db, "AAPL")
	if err != nil || len(quotes) != 1 || quotes[0].Open != result.Open || quotes[0].PrevClose != result.PrevClose {
		t.Fatalf("quotes=%v err=%v", quotes, err)
	}
	run, err := getRun(db, id)
	if err != nil || len(run.Results) != 1 || run.Results[0].Open != result.Open || run.Results[0].PrevClose != result.PrevClose {
		t.Fatalf("run=%v err=%v", run, err)
	}
	for _, name := range []string{"home", "stock", "run"} {
		var out bytes.Buffer
		if err := pages.ExecuteTemplate(&out, name, view{Stocks: stocks, Stock: stocks[0], Quotes: quotes, Run: run, Timezone: "UTC"}); err != nil {
			t.Fatal(err)
		}
		for _, text := range []string{"今开", "昨收", "101.23", "100"} {
			if !strings.Contains(out.String(), text) {
				t.Fatalf("%s missing %s", name, text)
			}
		}
	}
	// A later quote missing the optional fields must not inherit yesterday's open.
	id, err = createRun(db, []Stock{{Symbol: "AAPL"}}, "manual", 0, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := saveResult(db, id, Result{Symbol: "AAPL", Price: "104", Status: "ok"}); err != nil {
		t.Fatal(err)
	}
	stocks, err = listStocks(db)
	if err != nil || stocks[0].Open != "" || stocks[0].PrevClose != "" {
		t.Fatalf("stale optional prices: %v %v", stocks, err)
	}
}
