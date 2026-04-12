package anvilent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestLoginStoresTokens(t *testing.T) {
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/login" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		json.NewEncoder(w).Encode(loginResponse{
			AccessToken: "at", RefreshToken: "rt",
		})
	}))
	defer srv.Close()

	c := newTestClient(srv)
	if err := c.Login(context.Background(), "alice", "secret"); err != nil {
		t.Fatalf("Login: %v", err)
	}
	if gotBody["username"] != "alice" || gotBody["password"] != "secret" {
		t.Errorf("body = %v", gotBody)
	}
	if c.accessToken != "at" || c.refreshToken != "rt" {
		t.Errorf("tokens = %q/%q", c.accessToken, c.refreshToken)
	}
	if c.username != "alice" || c.password != "secret" {
		t.Errorf("creds = %q/%q", c.username, c.password)
	}
}

func TestLoginErrorReturnsAnvilError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte("bad creds"))
	}))
	defer srv.Close()

	err := newTestClient(srv).Login(context.Background(), "u", "p")
	ae, ok := err.(*AnvilError)
	if !ok {
		t.Fatalf("error type = %T", err)
	}
	if ae.Status != 401 {
		t.Errorf("status = %d", ae.Status)
	}
}

func TestRefreshTokenUsesStoredRefreshToken(t *testing.T) {
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/refresh" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		json.NewEncoder(w).Encode(loginResponse{AccessToken: "at2"})
	}))
	defer srv.Close()

	c := newTestClient(srv)
	c.refreshToken = "myrt"
	if err := c.RefreshToken(context.Background()); err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if gotBody["refresh_token"] != "myrt" {
		t.Errorf("refresh_token body = %q", gotBody["refresh_token"])
	}
	if c.accessToken != "at2" {
		t.Errorf("accessToken = %q", c.accessToken)
	}
}

func TestRefreshFallsBackToLoginWhenNoRefreshToken(t *testing.T) {
	var loginHits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth/login" {
			atomic.AddInt32(&loginHits, 1)
			json.NewEncoder(w).Encode(loginResponse{AccessToken: "at"})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := newTestClient(srv)
	c.username = "alice"
	c.password = "secret"
	if err := c.RefreshToken(context.Background()); err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if atomic.LoadInt32(&loginHits) != 1 {
		t.Errorf("expected 1 login hit, got %d", loginHits)
	}
}

func TestRefreshWithoutTokenOrCredsFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	err := newTestClient(srv).RefreshToken(context.Background())
	if err == nil {
		t.Error("expected error when no refresh token or credentials")
	}
}

func TestRegister(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/register" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	err := newTestClient(srv).Register(context.Background(), "bob", "b@x.com", "pw", []string{"reader"})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if gotBody["username"] != "bob" || gotBody["email"] != "b@x.com" {
		t.Errorf("body = %v", gotBody)
	}
	roles, _ := gotBody["roles"].([]any)
	if len(roles) != 1 || roles[0] != "reader" {
		t.Errorf("roles = %v", gotBody["roles"])
	}
}

func TestChangePassword(t *testing.T) {
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/change-password" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	err := newTestClient(srv).ChangePassword(context.Background(), "old", "new")
	if err != nil {
		t.Fatalf("ChangePassword: %v", err)
	}
	if gotBody["current_password"] != "old" || gotBody["new_password"] != "new" {
		t.Errorf("body = %v", gotBody)
	}
}
