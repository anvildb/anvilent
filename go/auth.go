package anvilent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// loginResponse is the internal representation of an auth token response.
type loginResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

// Login authenticates with the server using a username and password.
// On success, the client stores the tokens and attaches them to future requests.
func (c *Client) Login(ctx context.Context, username, password string) error {
	body := map[string]string{
		"username": username,
		"password": password,
	}
	var tokens loginResponse
	if err := c.doAuthRequest(ctx, "/auth/login", body, &tokens); err != nil {
		return err
	}
	c.mu.Lock()
	c.accessToken = tokens.AccessToken
	c.refreshToken = tokens.RefreshToken
	c.username = username
	c.password = password
	c.mu.Unlock()
	return nil
}

// RefreshToken exchanges the stored refresh token for a new access token.
func (c *Client) RefreshToken(ctx context.Context) error {
	return c.doRefreshToken(ctx)
}

// Register creates a new user account on the server.
func (c *Client) Register(ctx context.Context, username, email, password string, roles []string) error {
	body := map[string]any{
		"username": username,
		"email":    email,
		"password": password,
		"roles":    roles,
	}
	return c.doJSON(ctx, http.MethodPost, "/auth/register", body, nil)
}

// ChangePassword changes the current user's password.
func (c *Client) ChangePassword(ctx context.Context, currentPassword, newPassword string) error {
	body := map[string]string{
		"current_password": currentPassword,
		"new_password":     newPassword,
	}
	return c.doJSON(ctx, http.MethodPost, "/auth/change-password", body, nil)
}

// doRefreshToken performs the token refresh flow.
func (c *Client) doRefreshToken(ctx context.Context) error {
	c.mu.RLock()
	rt := c.refreshToken
	c.mu.RUnlock()

	if rt == "" {
		// No refresh token; try re-login with stored credentials.
		c.mu.RLock()
		user, pass := c.username, c.password
		c.mu.RUnlock()
		if user == "" {
			return fmt.Errorf("anvilent: no refresh token or credentials available")
		}
		return c.Login(ctx, user, pass)
	}

	body := map[string]string{"refresh_token": rt}
	var tokens loginResponse
	if err := c.doAuthRequest(ctx, "/auth/refresh", body, &tokens); err != nil {
		// Refresh failed; fall back to re-login.
		c.mu.RLock()
		user, pass := c.username, c.password
		c.mu.RUnlock()
		if user != "" {
			return c.Login(ctx, user, pass)
		}
		return err
	}

	c.mu.Lock()
	c.accessToken = tokens.AccessToken
	if tokens.RefreshToken != "" {
		c.refreshToken = tokens.RefreshToken
	}
	c.mu.Unlock()
	return nil
}

// doAuthRequest performs a JSON POST to an auth endpoint without token retry logic.
func (c *Client) doAuthRequest(ctx context.Context, path string, reqBody any, respBody any) error {
	data, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("anvilent: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("anvilent: create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("anvilent: auth request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return &AnvilError{
			Status:     resp.StatusCode,
			StatusText: http.StatusText(resp.StatusCode),
			Body:       string(b),
		}
	}

	if respBody != nil {
		return json.NewDecoder(resp.Body).Decode(respBody)
	}
	return nil
}
