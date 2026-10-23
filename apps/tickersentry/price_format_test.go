package main

import "testing"

func TestFormatPrice(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"", ""}, {"100", "100.00"}, {"1.2", "1.20"}, {"101.2349", "101.23"}, {"101.235", "101.24"}, {"9.999", "10.00"}, {"0.001", "0.00"}, {"invalid", "—"},
	} {
		if got := formatPrice(tc.input); got != tc.want {
			t.Errorf("formatPrice(%q)=%q, want %q", tc.input, got, tc.want)
		}
	}
}
