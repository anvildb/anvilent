package anvilent

import (
	"fmt"
	"net/url"
	"strings"
)

// ConnInfo holds the parsed components of an Anvil DB connection URI.
type ConnInfo struct {
	Host     string
	Port     string
	Username string
	Password string
	Database string
	TLS      bool
}

// ParseURI parses an anvil:// or anvil+tls:// connection URI into its components.
//
// The URI format is:
//
//	anvil://[user:pass@]host[:port][/database]
//	anvil+tls://[user:pass@]host[:port][/database]
//
// The default port is 7474.
func ParseURI(uri string) (*ConnInfo, error) {
	info := &ConnInfo{Port: "7474"}

	if strings.HasPrefix(uri, "anvil+tls://") {
		info.TLS = true
		uri = "http://" + strings.TrimPrefix(uri, "anvil+tls://")
	} else if strings.HasPrefix(uri, "anvil://") {
		uri = "http://" + strings.TrimPrefix(uri, "anvil://")
	} else {
		return nil, fmt.Errorf("anvilent: unsupported URI scheme, expected anvil:// or anvil+tls://")
	}

	parsed, err := url.Parse(uri)
	if err != nil {
		return nil, fmt.Errorf("anvilent: invalid URI: %w", err)
	}

	info.Host = parsed.Hostname()
	if info.Host == "" {
		return nil, fmt.Errorf("anvilent: missing host in URI")
	}

	if p := parsed.Port(); p != "" {
		info.Port = p
	}

	if parsed.User != nil {
		info.Username = parsed.User.Username()
		info.Password, _ = parsed.User.Password()
	}

	info.Database = strings.TrimPrefix(parsed.Path, "/")

	return info, nil
}
