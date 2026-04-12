package anvilent

import "testing"

func TestParseURI(t *testing.T) {
	tests := []struct {
		name    string
		uri     string
		want    ConnInfo
		wantErr bool
	}{
		{
			name: "plain with all fields",
			uri:  "anvil://alice:secret@db.example.com:9999/mydb",
			want: ConnInfo{
				Host: "db.example.com", Port: "9999",
				Username: "alice", Password: "secret",
				Database: "mydb", TLS: false,
			},
		},
		{
			name: "tls scheme",
			uri:  "anvil+tls://db.example.com/mydb",
			want: ConnInfo{
				Host: "db.example.com", Port: "7474",
				Database: "mydb", TLS: true,
			},
		},
		{
			name: "default port when omitted",
			uri:  "anvil://host",
			want: ConnInfo{Host: "host", Port: "7474"},
		},
		{
			name: "user without password",
			uri:  "anvil://bob@host:7474",
			want: ConnInfo{
				Host: "host", Port: "7474", Username: "bob",
			},
		},
		{
			name:    "unsupported scheme",
			uri:     "http://host",
			wantErr: true,
		},
		{
			name:    "missing host",
			uri:     "anvil:///mydb",
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseURI(tc.uri)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if *got != tc.want {
				t.Errorf("got %+v, want %+v", *got, tc.want)
			}
		})
	}
}
