# blog

我的博客源码，使用 Hexo 8 和 NexT 8。

## 安装与构建

使用 Node.js 24（`.nvmrc`）和 npm 11；仅维护 `package-lock.json`，不再使用 Yarn 锁文件。

```sh
nvm use
npm ci
npm test
npm run build
npm run server
```

`npm run deploy` 会向 `_config.yml` 中的两个远程仓库发布，需配置自己的 SSH 权限。

## 依赖安全维护

- 所有依赖从 npm 官方 HTTPS 源下载；提交依赖变更时必须同时提交锁文件。
- `js-yaml` 使用 `^4.3.2` override，在兼容的 4.x 内避免重新引入 GHSA-2883-xcg3-v3hh。
- Dependabot 每周检查 npm 和 GitHub Actions 更新，补丁和次版本更新合并为一组 PR。大版本更新单独检查兼容性。
- CI 对推送和 PR 运行干净安装、博客构建和完整 `npm audit`，每天复查新漏洞。审计有任何级别的漏洞都会失败，不跳过开发依赖，也不隐藏现存公告。
- 在 GitHub 的 Settings → Advanced Security 中检查 Dependabot alerts 和 Dependabot security updates 已启用；将 `build` 与 `audit` 检查设为默认分支合并要求。仓库配置文件无法代替这些 GitHub 设置。

本地复查：

```sh
npm audit
npm update
npm run clean
npm run build
```

### braces 本地安全补丁（2026-10-03）

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 影响 `braces <=3.0.3`，官方暂无修复版本。当前最新版 Hexo 仍经 `micromatch` 引入它；Nunjucks 和 Git 部署插件的文件监听依赖也引入它。升级后 npm audit 的 8 条高危记录都归因于这一公告，并非 8 个独立漏洞。

仓库通过 `scripts/patch-braces.cjs` 和 `patches/braces-3.0.3.json` 为所有安装的副本添加最大深度 128 的保护：解析器限制花括号和括号的嵌套，compile、expand 和 stringify 递归遍历同时限制深度，防止直接传入 AST 绕过解析器。超深输入抛出明确的 SyntaxError，普通模式保留原有行为。

`npm ci` / `npm install` 的 postinstall 会应用补丁，build、server、deploy、test 前也会重新验证，覆盖使用 `--ignore-scripts` 安装的情况。补丁校验源文件和补丁结果的 SHA-256，重复运行安全；源码或版本不匹配时中止，要求人工复核。`braces` 暂时固定为 3.0.3，上游发布修复后，应移除固定版本、补丁及对应生命周期脚本，重新生成锁文件并运行测试。

`npm test` 覆盖正常模式、恶意深层嵌套、未闭合模式、直接 AST 输入及文件监听。此补丁是仓库内的临时防护，不是官方修复版本；包版本保持真实，因此 npm audit 和 GitHub 告警仍会报告此漏洞，安全检查会持续失败直到上游修复或依赖替换完成。不要隐藏公告或使用 `npm audit fix --force` 建议的 Hexo 3.9.0 降级来规避记录。本站为静态输出，相关依赖运行在构建、预览和部署环境。

`themes/landscape` 保留为历史主题静态资源；已移除其不使用的 Grunt 下载工具和依赖声明。当前博客使用 npm 安装的 NexT，根目录不再安装备用 Landscape 包。
