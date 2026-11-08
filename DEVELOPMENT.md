<a id="development"></a>

# 开发

<a id="tests"></a>

## 测试

```sh
npm ci
npm test
npm run test:coverage
npm pack --dry-run
```

Node.js 测试套件通过 unittest discovery 调用全部 Python 辅助程序回归测试（Linux 使用 `python3`，Windows 使用 `python`）。单元测试覆盖会话启动与清理、辅助进程执行和取消及超时、WebDriver 协议错误、实时无障碍文本与属性及几何信息、选择器、原生窗口命令、树序列化和发布版本验证。子进程测试启动 Node 自身，不需要图形会话。Python 单元测试使用模拟 AT-SPI 对象，不需要 pyatspi。每个用例结束后恢复模拟对象。

`test:coverage` 只报告 JavaScript 覆盖率，不包含 Python 或桌面 E2E 覆盖率。它是诊断指标，不能替代原生验收。

<a id="linux-desktop-end-to-end-tests"></a>

### Linux 桌面端到端测试

安装 README 中列出的 Linux 运行依赖，以及隔离桌面工具：

```sh
sudo apt-get install -y xvfb xauth openbox
npm run test:e2e
```

运行器管理一个 1280x900 的 Xvfb 显示、窗口管理器和独立 D-Bus 会话。它打包实际 npm 发行包、解压，通过 Appium 扩展 CLI 安装，并启动独立的回环 Appium 服务器。APPIUM_HOME 和 npm global-link 前缀每轮运行独立。独立 GTK 夹具验证启动参数、环境和工作目录。各场景覆盖 Unicode 输入、实时文本和值读取、XPath、窗口缩放、元素几何信息、PNG 尺寸、失效控件、关闭模态窗口和进程停止。每个用例创建自己的应用会话，不需要手动桌面或原应用检出目录。Appium 扩展安装器需要 PATH 中有 npm。运行依赖已预构建，无需编译。

原始 Appium 和安装日志、受测 tarball，以及各用例的截图和页面源码保存在 `build/test-results/e2e/run-*`。诊断收集失败单独记录。关闭会话会等待应用终止，随后运行器关闭其 Appium 服务器和所管理的显示会话。

### CI

`test.yml` 在每个 PR 和向 `main` 的 push 上运行。单元测试在 Ubuntu 上使用 Node.js 22 和 24。桌面 E2E 针对 Appium 2 和 3 分别在使用 Node.js 24 的 Ubuntu job 中顺序执行场景。每个 E2E job 都测试打包后的扩展，即使断言失败也上传诊断资料。

测试和发布 workflow 使用 `actions/cache` 显式恢复和保存 npm 下载缓存，禁用 `setup-node` 缓存。始终不缓存 `node_modules`，每个 job 仍通过 `npm ci` 安装干净的依赖树。随后 E2E 兼容性 job 在不修改 lockfile 的前提下选择 Appium 主版本。

所有 job 都恢复最近可访问、匹配 `npm-downloads-v1-<OS>-<architecture>-` 的快照，不受 lockfile 变化影响。检查成功后，使用还包含 run ID、run attempt、job 和矩阵变体的新 key 保存扩充后的下载缓存。因此并行 job 和重跑各自写入独立快照，包括恢复时匹配了旧快照的情况。发布使用相同前缀，并在 publish 步骤前保存；验证共享缓存操作不需要实际发布。

保留 GitHub 原生缓存范围隔离：PR job 可恢复符合条件的 main 分支快照，PR 快照仍仅属于对应 PR ref。GitHub 管理缓存保留与容量淘汰，没有自定义清理。分支或 PR 的过时 workflow 运行会被取消。

<a id="releases"></a>

## 发布

发布由**发布 GitHub Release** 触发，使用 `release: published`，而不是推送 tag。这为维护者提供明确的发布步骤并支持草稿。Workflow 检出 tag 指向的提交，验证版本并重新运行测试，然后发布。

1. 更新 `package.json` 和 `package-lock.json`，例如运行 `npm version 0.1.1 --no-git-tag-version`，将变更合并到 `main`。
2. 等待测试 workflow 通过。
3. 在该提交创建 `v0.1.1` tag，并使用它发布 GitHub Release。
4. 确认 `Publish to npm` workflow 成功。

Tag 必须等于 `v` 加包版本。`0.2.0-beta.1` 等预发布版本必须标记为 GitHub prerelease，并发布到 npm 的 `next` 标签；稳定版本使用 `latest`。草稿 release 和单独推送 tag 都不会发布。npm 版本不可变，修正必须使用新版本。

Publish job 使用 Node.js 24 及其 npm 11 CLI，具有 `id-token: write` 权限并启用 provenance，沿用上述 npm 下载快照方案。

<a id="npm-authentication-setup"></a>

### npm 身份验证配置

对于已有包，在 npm 包设置中配置 **Trusted Publisher**：

- GitHub 组织或用户：运行 workflow 的仓库所有者（上游仓库为 `storytellerF`）。
- Repository：`appium-linux-driver`。
- Workflow filename：`publish.yml`。
- Environment：留空（workflow 未声明 environment）。
- 允许通过 `npm publish` 直接发布。

随后 OIDC 可在没有长期 npm 令牌的情况下发布。包的 `repository` URL 必须与发布仓库一致；移动到其他 fork 或上游时，应先更新 URL 再发布。

首次发布或尚未配置 trusted publishing 时，添加具有该包写权限的 npm 细粒度访问令牌，作为 GitHub Actions secret `NPM_TOKEN`。为无人值守发布启用其绕过 2FA 的权限，并设置合适的有效期。npm 账户必须拥有包名或具备发布权限。首次发布后，配置 trusted publishing 并删除引导用 secret。不得提交令牌或 `.npmrc` 凭据。仅添加这些 workflow 不会执行 release 或 npm 发布。

参考：[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) 和 [GitHub release 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)。
