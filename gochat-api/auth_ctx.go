package main

import "net/http"
import "strconv"

type ctxKey string

const ctxUserID ctxKey = "userID"
const ctxEmail ctxKey = "email"

func userIDFromRequest(r *http.Request) (int64, bool) {
	// Try a few common context keys (because your middleware might use a string key)
	keys := []any{ctxUserID, "userID", "userId", "uid"}

	for _, k := range keys {
		v := r.Context().Value(k)
		if v == nil {
			continue
		}

		switch t := v.(type) {
		case int64:
			return t, t > 0
		case int:
			id := int64(t)
			return id, id > 0
		case float64: // sometimes numbers come from JSON claims
			id := int64(t)
			return id, id > 0
		case string:
			id, err := strconv.ParseInt(t, 10, 64)
			return id, err == nil && id > 0
		default:
			// ignore unknown types
		}
	}

	return 0, false
}