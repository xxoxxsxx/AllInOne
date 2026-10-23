package main

import "github.com/shopspring/decimal"

// formatPrice rounds only the displayed value; stored prices retain their precision.
func formatPrice(raw string) string {
	if raw == "" {
		return ""
	}
	price, err := decimal.NewFromString(raw)
	if err != nil {
		return "—"
	}
	return price.StringFixed(2)
}
