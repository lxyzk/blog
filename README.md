# blog

我的博客源码，使用 Hexo 8 和 NexT 8。

## 安装与构建

使用 Node.js 24（`.nvmrc`）和 npm 11；仅维护 `package-lock.json`，不再使用 Yarn 锁文件。

```sh
nvm use
npm ci
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

### 尚未有上游修复的漏洞（2026-10-03）

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 影响 `braces <=3.0.3`，官方暂无修复版本。当前最新版 Hexo 仍经 `micromatch` 引入它；Nunjucks 和 Git 部署插件的文件监听依赖也引入它。升级后 npm audit 的 8 条高危记录都归因于这一公告，并非 8 个独立漏洞。

漏洞触发条件是处理恶意的深层嵌套 brace glob 表达式，可能导致 Node.js 进程栈耗尽。本站为静态输出，相关依赖运行在构建、预览和部署环境；目前不应让不受信任的输入修改 glob 配置或监听模式。此说明不是漏洞修复，审计检查会持续失败直到上游修复或依赖替换完成。不要使用 `npm audit fix --force` 建议的 Hexo 3.9.0 降级来规避记录。

`themes/landscape` 保留为历史主题静态资源；已移除其不使用的 Grunt 下载工具和依赖声明。当前博客使用 npm 安装的 NexT，根目录不再安装备用 Landscape 包。
