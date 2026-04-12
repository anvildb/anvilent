# Publishing anvilent Go module

Go modules are published directly from GitHub — there is no separate registry to upload to. Users install via `go get` which fetches the code from the git repository.

## Prerequisites

- The repo `github.com/anvildb/anvilent` must be public
- Go 1.21+ installed locally (for testing)

## 1. Verify the module

```bash
cd go
go vet ./...
go test ./...
```

## 2. Tag a release

Go modules use git tags for versioning. Since the Go module lives in the `go/` subdirectory, the tag must be prefixed with `go/`:

```bash
# From the repo root
git tag go/v0.1.0
git push origin go/v0.1.0
```

The module is now available. There is no upload step — the Go module proxy (https://proxy.golang.org) automatically caches it when first requested.

## 3. Verify

```bash
# In a new project
go get github.com/anvildb/anvilent/go@v0.1.0
```

Or check https://pkg.go.dev/github.com/anvildb/anvilent/go

Note: pkg.go.dev indexes the module automatically after the first `go get`. It may take a few minutes to appear.

## 4. Force indexing (optional)

To trigger pkg.go.dev indexing immediately:

```bash
curl "https://proxy.golang.org/github.com/anvildb/anvilent/go/@v/v0.1.0.info"
```

## Publishing updates

1. Bump code as needed (no version file to edit — Go uses git tags)
2. Tag the new version:
   ```bash
   git tag go/v0.1.1
   git push origin go/v0.1.1
   ```
3. For breaking changes, use a major version bump:
   ```bash
   # Update go.mod: module github.com/anvildb/anvilent/go/v2
   git tag go/v2.0.0
   git push origin go/v2.0.0
   ```

## Version format

Go modules follow [semver](https://semver.org/):
- `v0.x.x` — pre-1.0, no compatibility guarantees
- `v1.x.x` — stable API, backwards compatible within major version
- `v2.0.0+` — breaking changes require updating the module path to include `/v2`

## CI/CD (GitHub Actions)

No secrets or tokens needed. Just tag and push:

```yaml
- run: |
    cd go
    go vet ./...
    go test ./...
```

Publishing is just creating a git tag — no CI publish step required.

## Users install with

```bash
go get github.com/anvildb/anvilent/go@latest
```

```go
import anvilent "github.com/anvildb/anvilent/go"
```
