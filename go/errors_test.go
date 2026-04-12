package anvilent

import "testing"

func TestAnvilErrorError(t *testing.T) {
	withBody := &AnvilError{Status: 404, StatusText: "Not Found", Body: "missing"}
	if got, want := withBody.Error(), "anvil: 404 Not Found: missing"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}

	noBody := &AnvilError{Status: 500, StatusText: "Internal Server Error"}
	if got, want := noBody.Error(), "anvil: 500 Internal Server Error"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
