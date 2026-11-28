# Working in this repository

## Every change must keep all tests passing

Before you commit, open a pull request or merge, run these and make sure each one passes:

```
npm ci --prefix agent-runner && npm ci --prefix kiro-runner   # once: the tests import the runners' code
npm run typecheck
npm test                  # the whole backend and web test suite (about 5,400 tests)
npm run test:map:check    # every test file belongs to a module in test/test-map.json
npm run build
npm run test:ui           # UI smoke suite: builds, starts the portal and drives the pages (needs Chromium)
```

- Fix a failing test at its cause. Never skip, delete or loosen a test to get green, and never add one to
  `test/known-failures.json` without the person's agreement.
- A test must not depend on the network (AWS, GitHub, Telegram…). Stub the call in the test.
- New test files go into `test/test-map.json` under their module.
- While fixing, re-run only the files that failed (`npm run test:file -- test/x.test.ts`), then the whole
  suite once more before you push.
- Merge a pull request only when the CI workflow (`.github/workflows/ci.yml`: "Types, backend tests,
  build", "UI smoke tests" and the repository contract tests) is green on its latest commit. If CI did not
  run (for example the workflow is disabled in GitHub Actions), say so instead of merging silently.

### Browser tests in a sandbox

The `web-*` tests start Chromium through Playwright. If they fail with "Executable doesn't exist at
…/chromium_headless_shell-NNNN", the machine has a different Playwright browser build. Either run
`npx playwright install --only-shell chromium`, or point `PLAYWRIGHT_BROWSERS_PATH` at a folder that links
`chromium_headless_shell-NNNN` to the build you have. That is a setup problem, not a failing test.
