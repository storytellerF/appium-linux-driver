# Development

## Tests

```sh
npm ci
npm test
npm run test:coverage
npm pack --dry-run
```

The Node.js suite invokes all Python helper regressions using unittest discovery
(`python3` on Linux, `python` on Windows). Unit tests cover session startup and
cleanup, helper process execution/cancellation/timeouts, WebDriver protocol
errors, live accessible text/attributes and geometry, selectors, native window
commands, tree serialization, and release-version validation. Subprocess tests
launch Node itself and need no graphical session. Python unit tests use mocked
AT-SPI objects; they do not require pyatspi. Test mocks are restored per case.

`test:coverage` reports JavaScript coverage only, not Python or desktop E2E
coverage. It is a diagnostic measurement, not a substitute for native acceptance.

### Linux desktop end-to-end tests

Install the Linux runtime packages listed in the README plus the isolated desktop
tools:

```sh
sudo apt-get install -y xvfb xauth openbox
npm run test:e2e
```

The runner owns a 1280x900 Xvfb display, a window manager and a separate D-Bus
session. It packs the actual npm distribution, extracts it, installs it through
Appium's extension CLI, and starts a separate loopback Appium server. Both
APPIUM_HOME and npm's global-link prefix are unique to the run. An independent
GTK fixture verifies launch arguments, environment and working directory.
Scenarios exercise Unicode input and live text/value reads, XPath, window
resizing, element geometry, PNG dimensions, stale controls, modal dismissal and
process shutdown. Each case creates its own application session; no manual
desktop or original application checkout is needed. npm must be on PATH for
Appium's extension installer. Runtime dependencies are prebuilt; no compilation
is required.

Raw Appium/install logs, the tested tarball and per-case screenshots/page sources
are retained under `build/test-results/e2e/run-*`. Diagnostic collection failures
are recorded separately. Closing a session waits for application termination;
the runner shuts down its Appium server and owned display session afterward.

### CI

`test.yml` runs on every PR and push to `main`. Unit tests run on Ubuntu with
Node.js 22 and 24. Desktop E2E runs sequential scenarios on separate Ubuntu jobs
for Appium 2 and 3 with Node.js 24. Every E2E job tests the packaged extension,
and uploads its diagnostics even when an assertion fails.

`setup-node` caches npm downloads using `package-lock.json`; `npm ci` still
installs a clean tree. The E2E compatibility jobs then select the target Appium
major without changing the lockfile. Obsolete runs for a branch or PR are
cancelled.

## Releases

Publishing is triggered by **publishing a GitHub Release**, using
`release: published`, rather than by pushing a tag. This gives maintainers an
explicit release step and supports drafts. The workflow checks out the tagged
commit, validates the version, and reruns tests before publishing.

1. Update `package.json` and `package-lock.json`, for example with
   `npm version 0.1.1 --no-git-tag-version`, and merge the change into `main`.
2. Wait for the test workflow to pass.
3. Create a tag `v0.1.1` on that commit and publish a GitHub Release using it.
4. Confirm the `Publish to npm` workflow succeeds.

Tags must equal `v` plus the package version. A prerelease version such as
`0.2.0-beta.1` must be marked as a GitHub prerelease; it publishes under npm's
`next` tag. Stable versions use `latest`. Draft releases and tag pushes alone do
not publish. npm versions are immutable: corrections require a new version.

The publish job uses Node.js 24 and its npm 11 CLI, with `id-token: write` and
provenance. It does not restore dependency caches in the publishing job.

### npm authentication setup

For an existing package, configure an npm **Trusted Publisher** in the package
settings with:

- GitHub organization/user: the owner of the repository running the workflow
  (this fork: `AgentStart1`).
- Repository: `appium-linux-driver`.
- Workflow filename: `publish.yml`.
- Environment: leave blank (the workflow does not declare an environment).
- Allow direct publishing with `npm publish`.

OIDC then publishes without a long-lived npm token. The package's `repository`
URL must match the publishing repository; update it if moving to another fork
or upstream before publishing.

For a first publication, or if trusted publishing is not configured, add an npm
granular access token with write access to this package as the GitHub Actions
secret `NPM_TOKEN`. Enable its bypass-2FA permission for unattended publishing
and use an appropriate expiration. The npm account must own the package name
or have publishing rights. After the first publication, configure trusted
publishing and remove the bootstrap secret. Do not commit tokens or `.npmrc`
credentials. No release or npm publication is performed merely by adding these
workflows.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
and [GitHub release events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release).
