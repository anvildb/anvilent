# Publishing anvilent to PyPI

## Prerequisites

- Python 3.10+ installed
- A PyPI account (https://pypi.org/account/register/)

## 1. Create a PyPI account

1. Go to https://pypi.org/account/register/
2. Verify your email address
3. Enable 2FA (required for new projects)

## 2. Create an API token

1. Go to https://pypi.org/manage/account/token/
2. Token name: `anvilent-publish`
3. Scope: "Entire account" for the first upload, then scope to "anvilent" project after
4. Copy the token (starts with `pypi-`)

## 3. Install build tools

```bash
pip install build twine
```

## 4. Build the package

```bash
cd python
python -m build
```

This creates `dist/anvilent-0.1.0.tar.gz` and `dist/anvilent-0.1.0-py3-none-any.whl`.

## 5. Verify the package

```bash
twine check dist/*
```

Fix any warnings about missing metadata or README rendering issues.

## 6. Test on TestPyPI (optional but recommended)

```bash
twine upload --repository testpypi dist/*
```

When prompted:
- Username: `__token__`
- Password: your TestPyPI token (create at https://test.pypi.org/manage/account/token/)

Verify at https://test.pypi.org/project/anvilent/

Install from TestPyPI to test:
```bash
pip install --index-url https://test.pypi.org/simple/ anvilent
```

## 7. Publish to PyPI

```bash
twine upload dist/*
```

When prompted:
- Username: `__token__`
- Password: your PyPI token (the `pypi-...` string)

Or use a config file at `~/.pypirc`:
```ini
[pypi]
username = __token__
password = pypi-YOUR-TOKEN-HERE
```

The package will be available at https://pypi.org/project/anvilent/ within seconds.

## 8. Verify

```bash
pip install anvilent
```

Or check https://pypi.org/project/anvilent/

## Publishing updates

1. Bump `version` in `pyproject.toml`
2. Remove old dist: `rm -rf dist/`
3. Build: `python -m build`
4. Upload: `twine upload dist/*`

Note: PyPI versions are immutable — you cannot overwrite a published version.

## CI/CD (GitHub Actions)

Add `PYPI_TOKEN` to the repo secrets, then use:

```yaml
- uses: actions/setup-python@v5
  with:
    python-version: '3.12'
- run: pip install build twine
- run: cd python && python -m build && twine upload dist/*
  env:
    TWINE_USERNAME: __token__
    TWINE_PASSWORD: ${{ secrets.PYPI_TOKEN }}
```
