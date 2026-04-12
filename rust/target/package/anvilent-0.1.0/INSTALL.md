# Publishing anvilent to crates.io

## Prerequisites

- Rust toolchain installed
- A crates.io account (login via GitHub at https://crates.io)

## 1. Create an API token

1. Go to https://crates.io/settings/tokens
2. Click "New Token"
3. Name: `anvilent-publish`
4. Scopes: `publish-new`, `publish-update`
5. Copy the token

## 2. Login locally

```bash
cargo login <your-token>
```

This saves the token to `~/.cargo/credentials.toml`.

## 3. Verify the package

```bash
cd rust
cargo publish --dry-run
```

This builds the crate and checks for issues without uploading. Fix any warnings about:
- Missing `license` or `description` in Cargo.toml
- Files that shouldn't be included (add to `.gitignore` or `exclude` in Cargo.toml)

## 4. Publish

```bash
cargo publish
```

The crate will be available at https://crates.io/crates/anvilent within a few minutes.

## 5. Verify

```bash
# In a new project
cargo add anvilent
```

Or check https://crates.io/crates/anvilent

## Publishing updates

1. Bump `version` in `Cargo.toml`
2. `cargo publish`

Note: crates.io versions are immutable — you cannot overwrite a published version. Always bump the version number.

## CI/CD (GitHub Actions)

Add `CARGO_REGISTRY_TOKEN` to the repo secrets (Settings > Secrets > Actions), then use:

```yaml
- run: cd rust && cargo publish
  env:
    CARGO_REGISTRY_TOKEN: ${{ secrets.CARGO_REGISTRY_TOKEN }}
```
