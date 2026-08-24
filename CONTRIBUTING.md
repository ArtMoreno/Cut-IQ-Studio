# Contributing

Issues and pull requests are welcome. Keep changes focused, preserve local-first privacy boundaries, and include tests for behavior changes.

Before opening a pull request, run:

```powershell
npm ci
npm test
npm run check
npm run lint
npm run build
```

Do not commit `.env` files, credentials, media, database data, generated installers, or machine-specific paths.
