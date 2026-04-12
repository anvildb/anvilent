# Publishing anvilent to npm

## Prerequisites

- Node.js 18+ installed
- An npm account (https://www.npmjs.com/signup)

## 1. Create an npm account

1. Go to https://www.npmjs.com/signup
2. Verify your email address
3. Optionally enable 2FA (recommended for publishing)

## 2. Login locally

```bash
npm login
```

Enter your username, password, and email. If 2FA is enabled, enter the OTP.

## 3. Build the package

```bash
cd typescript
npm install
npm run build
```

This produces `dist/` with ESM, CJS, and type definitions.

## 4. Verify the package contents

```bash
npm pack --dry-run
```

Check that only `dist/`, `package.json`, `README.md`, and `LICENSE` are included. The `files` field in `package.json` controls what gets published.

## 5. Publish

```bash
npm publish
```

If the package name `anvilent` is taken, you can use a scoped name:
```bash
# In package.json, change name to "@anvildb/anvilent"
npm publish --access public
```

The package will be available at https://www.npmjs.com/package/anvilent within seconds.

## 6. Verify

```bash
# In a new project
npm install anvilent
```

Or check https://www.npmjs.com/package/anvilent

## Publishing updates

1. Bump version: `npm version patch` (or `minor` / `major`)
2. Build: `npm run build`
3. Publish: `npm publish`

## Access tokens for CI

1. Go to https://www.npmjs.com/settings/tokens
2. Click "Generate New Token"
3. Select "Automation" (bypasses 2FA for CI)
4. Copy the token

## CI/CD (GitHub Actions)

Add `NPM_TOKEN` to the repo secrets, then use:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
    registry-url: https://registry.npmjs.org
- run: cd typescript && npm ci && npm run build && npm publish
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```
