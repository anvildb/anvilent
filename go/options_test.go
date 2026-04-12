package anvilent

import (
	"testing"
	"time"
)

func TestWithTimeout(t *testing.T) {
	c := New(WithTimeout(5 * time.Second))
	if c.httpClient.Timeout != 5*time.Second {
		t.Errorf("got %v, want 5s", c.httpClient.Timeout)
	}
}

func TestWithTLS(t *testing.T) {
	c := New(WithTLS())
	if !c.useTLS {
		t.Error("useTLS should be true")
	}
}

func TestWithAuth(t *testing.T) {
	c := New(WithAuth("alice", "secret"))
	if c.username != "alice" || c.password != "secret" {
		t.Errorf("got %q/%q, want alice/secret", c.username, c.password)
	}
}

func TestNewDefaults(t *testing.T) {
	c := New()
	if c.httpClient.Timeout != 30*time.Second {
		t.Errorf("default timeout = %v, want 30s", c.httpClient.Timeout)
	}
	if c.useTLS {
		t.Error("useTLS should default to false")
	}
}
