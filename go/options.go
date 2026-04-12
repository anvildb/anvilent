package anvilent

import "time"

// Option configures a Client.
type Option func(*Client)

// WithTimeout sets the HTTP client timeout. The default is 30 seconds.
func WithTimeout(d time.Duration) Option {
	return func(c *Client) {
		c.httpClient.Timeout = d
	}
}

// WithTLS forces TLS (https) for all requests, regardless of the URI scheme.
func WithTLS() Option {
	return func(c *Client) {
		c.useTLS = true
	}
}

// WithAuth sets the username and password for authentication.
// The client will automatically log in when the first request is made.
func WithAuth(username, password string) Option {
	return func(c *Client) {
		c.username = username
		c.password = password
	}
}
