//! URI parsing for `anvil://` and `anvil+tls://` connection strings.

use crate::error::AnvilError;

/// Parsed components of an Anvil DB connection URI.
#[derive(Debug, Clone)]
pub struct AnvilUri {
    /// Whether to use TLS (https) for the connection.
    pub tls: bool,
    /// Hostname.
    pub host: String,
    /// Port number (defaults to 7474).
    pub port: u16,
    /// Optional database name from the URI path.
    pub database: Option<String>,
    /// Optional username from the URI credentials.
    pub username: Option<String>,
    /// Optional password from the URI credentials.
    pub password: Option<String>,
}

impl AnvilUri {
    /// Parse an `anvil://` or `anvil+tls://` URI string.
    ///
    /// # Format
    ///
    /// ```text
    /// anvil://[user:pass@]host[:port][/database]
    /// anvil+tls://[user:pass@]host[:port][/database]
    /// ```
    ///
    /// - `anvil://` uses plain HTTP.
    /// - `anvil+tls://` uses HTTPS.
    /// - Default port is 7474.
    pub fn parse(uri: &str) -> Result<Self, AnvilError> {
        let (tls, rest) = if let Some(rest) = uri.strip_prefix("anvil+tls://") {
            (true, rest)
        } else if let Some(rest) = uri.strip_prefix("anvil://") {
            (false, rest)
        } else {
            return Err(AnvilError::InvalidUri(
                "URI must start with anvil:// or anvil+tls://".to_string(),
            ));
        };

        // Split credentials from host
        let (credentials, host_part) = if let Some(at_pos) = rest.rfind('@') {
            (Some(&rest[..at_pos]), &rest[at_pos + 1..])
        } else {
            (None, rest)
        };

        let (username, password) = if let Some(creds) = credentials {
            if let Some(colon_pos) = creds.find(':') {
                let user = &creds[..colon_pos];
                let pass = &creds[colon_pos + 1..];
                (
                    Some(urldecode(user)),
                    Some(urldecode(pass)),
                )
            } else {
                (Some(urldecode(creds)), None)
            }
        } else {
            (None, None)
        };

        // Split host:port from /database
        let (host_port, database) = if let Some(slash_pos) = host_part.find('/') {
            let db = &host_part[slash_pos + 1..];
            let db = if db.is_empty() { None } else { Some(db.to_string()) };
            (&host_part[..slash_pos], db)
        } else {
            (host_part, None)
        };

        // Split host and port
        let (host, port) = if let Some(colon_pos) = host_port.rfind(':') {
            let port_str = &host_port[colon_pos + 1..];
            let port = port_str.parse::<u16>().map_err(|_| {
                AnvilError::InvalidUri(format!("Invalid port: {port_str}"))
            })?;
            (host_port[..colon_pos].to_string(), port)
        } else {
            (host_port.to_string(), 7474)
        };

        if host.is_empty() {
            return Err(AnvilError::InvalidUri("Host cannot be empty".to_string()));
        }

        Ok(Self {
            tls,
            host,
            port,
            database,
            username,
            password,
        })
    }

    /// Build the base HTTP URL from this parsed URI.
    pub fn base_url(&self) -> String {
        let scheme = if self.tls { "https" } else { "http" };
        format!("{scheme}://{}:{}", self.host, self.port)
    }
}

/// Simple percent-decoding for URI components.
fn urldecode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next();
            let lo = chars.next();
            if let (Some(hi), Some(lo)) = (hi, lo) {
                let hex = [hi, lo];
                if let Ok(s) = std::str::from_utf8(&hex) {
                    if let Ok(val) = u8::from_str_radix(s, 16) {
                        result.push(val as char);
                        continue;
                    }
                }
            }
            result.push('%');
        } else if b == b'+' {
            result.push(' ');
        } else {
            result.push(b as char);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_uri() {
        let uri = AnvilUri::parse("anvil://localhost").unwrap();
        assert!(!uri.tls);
        assert_eq!(uri.host, "localhost");
        assert_eq!(uri.port, 7474);
        assert!(uri.database.is_none());
        assert!(uri.username.is_none());
    }

    #[test]
    fn parse_full_uri() {
        let uri = AnvilUri::parse("anvil://admin:secret@db.example.com:9999/mydb").unwrap();
        assert!(!uri.tls);
        assert_eq!(uri.host, "db.example.com");
        assert_eq!(uri.port, 9999);
        assert_eq!(uri.database.as_deref(), Some("mydb"));
        assert_eq!(uri.username.as_deref(), Some("admin"));
        assert_eq!(uri.password.as_deref(), Some("secret"));
    }

    #[test]
    fn parse_tls_uri() {
        let uri = AnvilUri::parse("anvil+tls://host:8080/prod").unwrap();
        assert!(uri.tls);
        assert_eq!(uri.base_url(), "https://host:8080");
    }

    #[test]
    fn reject_invalid_scheme() {
        assert!(AnvilUri::parse("http://localhost").is_err());
    }
}
