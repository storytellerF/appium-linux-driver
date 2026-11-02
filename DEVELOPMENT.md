# Development

## Tests

```sh
npm ci
npm test
npm pack --dry-run
```

The Node.js suite also invokes the Python helper regression suite (`python3` on
Linux, `python` on Windows). These are unit regressions with mocked AT-SPI
objects; they do not launch a real graphical application or require pyatspi.
Real desktop acceptance needs the Linux dependencies and graphical session in
the README. No Gradle project or original application checkout is needed.

`test.yml` runs on every pull request and push to `main`, on Ubuntu with Node.js
22 and 24. `setup-node` caches npm downloads keyed by `package-lock.json`;
`npm ci` still installs a clean dependency tree on every run. Obsolete runs for
the same branch or PR are cancelled.

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
