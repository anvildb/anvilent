// Package anvilent provides a Go client driver for Anvil DB.
package anvilent

import "fmt"

// AnvilError represents an HTTP error response from the Anvil DB server.
type AnvilError struct {
	// Status is the HTTP status code returned by the server.
	Status int
	// StatusText is the HTTP status text (e.g. "Not Found").
	StatusText string
	// Body is the raw response body.
	Body string
}

// Error implements the error interface.
func (e *AnvilError) Error() string {
	if e.Body != "" {
		return fmt.Sprintf("anvil: %d %s: %s", e.Status, e.StatusText, e.Body)
	}
	return fmt.Sprintf("anvil: %d %s", e.Status, e.StatusText)
}
