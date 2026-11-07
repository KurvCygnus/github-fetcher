[English](https://github.com/KurvCygnus/github-fetcher/blob/main/README.md) | [简体中文](https://github.com/KurvCygnus/github-fetcher/blob/main/README.zh-CN.md)

# @kurvcygnus/github-fetcher

[![npm version](https://img.shields.io/npm/v/@kurvcygnus/github-fetcher.svg)](https://www.npmjs.com/package/@kurvcygnus/github-fetcher)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.19-blue)

AI 编码 agent 的日常工作几乎全在读 GitHub, 而直连 GitHub 的读取路径既不安全也不省钱, 更谈不上可靠. `@kurvcygnus/github-fetcher` 是一个只读的 GitHub MCP server: 它通过 stdio 暴露 22 个工具, 走 GitHub REST API 读取仓库, 文件, commit, issue, pull request, release, 仓库健康, 仓库横向对比, 自身的工具能力索引, Actions 和搜索结果. 它复用你已有的凭据, 能绕开不可靠的网络, 把响应缓存到磁盘, 并且无法修改任何东西.

## 为中国大陆网络而构建

GitHub 匿名 REST 配额是**每个出口 IP 每小时 60 次**, 由机器上的所有工具共享. `raw.githubusercontent.com` 经常被 DNS 污染, 缺少 `User-Agent` 的裸 HTTP 请求会直接收到 403. 这个 server 围绕这些故障设计:

- 复用 git credential store 里已有的 token; `GITHUB_TOKEN`/`GH_TOKEN` 优先.
- API 先直连, 失败后走代理. 读取文件时先用 contents API 取元数据和内联内容, GitHub 不返回内联正文时再经代理从 `raw.githubusercontent.com` 取.
- 每条路由对传输失败重试两次, 15 秒以内的限流窗口自动等待, 更长窗口报告精确重置时间.
- 成功响应带 ETag 缓存到磁盘, 重复读取不消耗配额.

不在中国大陆时默认配置同样可用; 设置 `GITHUB_PROXY_MODE=direct` 可以完全跳过代理尝试.

## 问题所在

Agent 访问 GitHub 的频率极高 (读目录树, 读文件, 查 issue, 查 pull request, 看 CI), 而直连访问会以各种方式失败, 浪费所有人的时间:

- 匿名 REST 访问的配额是每 IP 每小时 60 次请求, 由机器上的所有工具共享.
- GitHub 会用 403 拒绝没有 `User-Agent` 头的请求, 裸脚本因此报错, 且原因很难察觉.
- 在 `raw.githubusercontent.com` 被 DNS 污染的网络 (中国大陆很常见) 上, raw 文件抓取直接失败.
- 为了只读工作给 agent 配一个带写权限的 token 是不必要的风险.
- 没有共享缓存时, 每个工具都会重复抓取同样的内容.

## 你能得到什么

- 通过 stdio 暴露的 22 个只读 MCP 工具: 仓库, 目录树, 文件, commit, 分支, issue, pull request, release, 仓库健康, 仓库横向对比, 工具能力索引, 搜索, Actions 运行记录, 以及一个通用的只读 GET 兜底工具.
- 复用 git credential store 里的 token: 服务器读取你的 git credential helper 已保存的凭据 (例如 GitHub CLI 或 Git Credential Manager), 不会在磁盘上新增秘密. `GITHUB_TOKEN` 优先; 完全没有 token 时退回匿名访问 (每小时 60 次请求).
- 为恶劣网络设计的代理路由: `auto` 模式下 API 请求先直连, `raw.githubusercontent.com` 请求先走代理; 可用 `always` 和 `direct` 覆盖. 代理候选按顺序尝试: `GITHUB_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, 然后是 git 的代理配置.
- 能在重启后存活的 ETag 磁盘缓存: 未超过 TTL 的条目直接本地返回, 过期条目用 `If-None-Match`/`If-Modified-Since` 廉价重验证, 收到 304 就复用已存的响应体, 不再重新下载.
- 速率限制处理: 短窗口 (15 秒以内) 自动等待一次后重试; 长窗口则报错并给出精确的重置时间.
- 内置客户端配置: `github-fetcher init` 为八种客户端写入 MCP 条目, 改动前先备份文件; `github-fetcher remove` 可以撤销.

## 与官方 server 的对比

官方 `github/github-mcp-server` 适合需要通用 GitHub MCP, 写工具或远程托管的场景. 这个项目做的是更窄的取舍:

| 能力 | GitHub Fetcher | 官方 github-mcp-server |
| --- | --- | --- |
| 始终只读 | 是 | 只读模式需显式开启; 默认提供写工具 |
| 本地 stdio | 是 | 是 |
| 远程托管 | 否 | 是 |
| 认证 | 复用 git credential; `GITHUB_TOKEN`/`GH_TOKEN` | PAT, OAuth 或 GitHub App |
| 中国大陆 raw/代理回退 | 是 | 没有针对中国大陆的路由 |
| ETag 磁盘缓存 | 是 | 没有内置 ETag 缓存 |

官方 server 的信息按 2026-11-01 的 README 核对.

## 快速开始

最快的方式是一条命令:

    npx -y @kurvcygnus/github-fetcher@latest init

`init` 会检测支持的客户端, 复用已经指向本包的现有条目, 并在修改每个文件前备份. 下面的手动配置是参考形式.

把对应的条目加进你客户端的 MCP 配置.

OpenCode:

```json
{
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "-y", "@kurvcygnus/github-fetcher@latest"],
      "enabled": true
    }
  }
}
```

Claude Desktop, 加到 `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@kurvcygnus/github-fetcher@latest"],
      "env": { "GITHUB_TOKEN": "ghp_your_token" }
    }
  }
}
```

Cursor, 加到 `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@kurvcygnus/github-fetcher@latest"]
    }
  }
}
```

VS Code, 加到 `.vscode/mcp.json`:

```json
{
  "servers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@kurvcygnus/github-fetcher@latest"]
    }
  }
}
```

四个客户端运行的是同一条命令; 在客户端支持的位置加一个带 `GITHUB_TOKEN` 的 `env` 块, 或者在启动客户端的 shell 里 export 这个变量.

## CLI

每个工具同时也是同一个二进制的子命令 - 适合 shell 管道, 也适合在没有 agent 参与的情况下查看数据.

全局安装 (`npm i -g @kurvcygnus/github-fetcher`) 后会同时注册短别名 `ghf`, `ghf releases anomalyco/opencode --per-page 5` 同样可用.

    github-fetcher releases anomalyco/opencode --per-page 5 | jq -r ".items[].tag_name"
    github-fetcher health anthropics/claude-code --window-days 30 --pretty
    github-fetcher file KurvCygnus/github-fetcher README.md

- 直接运行 `github-fetcher` (或 `serve`) 启动 MCP stdio server; 带子命令则走 CLI.
- stdout 输出紧凑 JSON (`--pretty` 输出缩进格式, 适合人类阅读); 错误以 JSON 写到 stderr, 退出码: 2 用法, 3 速率限制, 4 认证, 5 未找到, 6 网络, 7 上游.
- `--version` (`-v`) 输出包版本; `--help` 列出子命令, `github-fetcher <subcommand> --help` 显示单个工具的参数.
- `init` 和 `remove` 管理 MCP 客户端配置, 不查询 GitHub; 详见下文.

### `init`

`github-fetcher init` 把 `github` 条目写入你的 MCP 客户端配置. 在终端里它会打开选择菜单 (空格切换, `a` 全选或全不选, 回车确认, Esc 取消; 配置文件已存在的客户端默认选中). 脚本里改用参数:

    github-fetcher init --dry-run
    github-fetcher init --client opencode,cursor
    github-fetcher init --client opencode --name github

- `--client id,id` 指定客户端 (逗号分隔); `--all` 覆盖所有适配器; `--dry-run` 只报告 `would-create`, `would-update` 或 `would-skip`, 不改动文件; `--name` 设置条目名 (默认 `github`). 只带 `--dry-run` 而不给 `--client` 或 `--all` 时同样会覆盖所有适配器, 检测不到的客户端报告 `not-installed`, 不会报告 `would-create`.
- 默认情况下, `init` 会复用 `command` 或 `args` 已指向本包的现有条目, 即使它的键是 `github-fetcher` 这样的旧名称, 也会原地更新该条目而不是新增重复项. `--name` 会关闭解析并强制使用指定的键. 已经属于其他服务器的键绝不会被覆盖: 如果没有本包拥有的旧键可复用, 客户端会报告 `skipped`, 可用 `--name` 选择其他键.
- 只有在显式选中某个客户端时才会新建缺失的配置文件 (`--client`, 或在菜单里勾选); 未被选中且检测不到的客户端报告 `not-installed`, 不会为它写任何文件. 单独使用 `--all` 覆盖所有已检测到的客户端, 其余报告为 `not-installed`.
- 改动已有文件前都会在同目录备份为 `<path>.bak.<timestamp>`; 备份写完才会改动目标文件; 同一秒内重跑会改用数字后缀, 不覆盖先前的备份.
- stdout 输出一个 JSON 数组, 每个客户端一个对象 (`created`, `updated`, `skipped`, `not-installed`, `would-*`, `error`), 并包含解析后的条目 `name`; 解析到的认证方式 (`token` 或 `anonymous`) 写到 stderr. 取消菜单会输出 `cancelled` 并以 0 退出.

支持的客户端: `opencode`, `claude-desktop`, `claude-code`, `cursor`, `vscode`, `gemini`, `windsurf`, `codex`.

### `remove`

`github-fetcher remove` 删除这个条目. 不带参数时只列出配置里确实含有该条目的客户端, 并全部预选; `--client id,id` 和 `--all` 跳过菜单, `--name` 指定要删除哪个条目. 不带参数时 `remove` 需要交互式终端来显示菜单, stdin 不是 TTY 时会以 2 退出; 无人值守时用 `--client` 或 `--all`.

- 只处理已存在的条目: 没有配置文件的客户端报告 `not-installed`, 配置里没有该条目的客户端报告 `skipped`, 这两种情况都不会重写文件. 属于其他服务器的键绝不会被删除; 这种情况报告 `skipped` 并附带说明.
- 删除前会把当前文件备份, 命名与 `init` 相同 (`<path>.bak.<timestamp>`).
- 删除最后一个条目后, 如果配置文件会变成空文件, 该文件会被删除; 结果中标记 `deleted: true`, 备份保留下来作为恢复副本. 存在顶层键或同级条目时文件会保留.
- ZCode 有意不支持: 它不是适配器, `init` 不会提供它, `remove` 也不会读写它的配置.

## 限制

- 从构造上只读: 不支持写操作, GraphQL, clone 或 archive 工具.
- 22 个工具, 不是完整的 GitHub API 客户端; 专用工具没覆盖的只读 REST 端点用 `github_api_get`.
- 匿名访问每小时 60 次; 代码搜索需要 token.
- 不内置代理; 请自备 HTTP(S) 代理.
- 缓存会把响应体写到磁盘; 共享账号无法接受这一点时不要使用.

## 安全模型

- 从构造上只读: 服务器只发出 GET 请求; 不支持 GraphQL 和写操作, `github_api_get` 接受任意只读 GET 路径, 主机固定为 api.github.com.
- 只会联系两个主机: API 请求只到 `api.github.com`, raw 字节只来自 `raw.githubusercontent.com`.
- 重定向被限制在 GitHub origin 之内: 离开原主机的重定向会被拒绝.
- Token 只出现在 Authorization 头里, 绝不进入日志, 错误信息, 工具输出或缓存; 缓存键使用 token 的 SHA-256 哈希.
- 缓存文件以 0600 权限写入 (尽力而为), 位置在用户自己的缓存目录下.
- 身份默认私密: `github_rate_limit` 只报告配额. 设置 `GITHUB_MCP_EXPOSE_IDENTITY` 后才追加 `authenticated_as` 和 `scopes`; 无论开关, token 和它的指纹都不会返回.

## 工作原理

每次工具调用都会变成一次针对 GitHub REST API 的 GET 请求. 请求先经过缓存层: 未超过端点 TTL 的条目直接本地返回, 过期条目用 ETag 重验证; 只有成功的响应才会进缓存, 所以 not-found 响应永远不会被缓存, 每次都以 `not_found` 错误呈现. 除 `github_rate_limit` 和 `github_api_get` 外, 每个读取 API 的工具都接受 `fresh` 选项, 为单次请求绕过缓存; `github_capabilities` 不接受输入. 缓存之下, HTTP 层为每个请求选择路由, 重试传输失败, 自动等过短的速率限制窗口, 并在 token 被拒时刷新一次再放弃.

`stdio MCP → tool registry → GithubClient (ETag cache) → HttpClient (routing, proxy, retries) → GitHub REST`

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 未设置 | GitHub token, 最先尝试. |
| `GH_TOKEN` | 未设置 | 备用 token, 在 `GITHUB_TOKEN` 未设置时使用. |
| `GITHUB_PROXY` | 未设置 | 专用代理 URL (`http://` 或 `https://`), 优先于通用代理变量. |
| `GITHUB_PROXY_MODE` | `auto` | 代理路由模式: `auto`, `always` 或 `direct`. |
| `HTTPS_PROXY` | 未设置 | 通用 HTTPS 代理兜底. |
| `HTTP_PROXY` | 未设置 | 通用 HTTP 代理兜底, 在 `HTTPS_PROXY` 之后尝试. |
| `GITHUB_CACHE` | `disk` | 缓存后端: `disk`, `memory` 或 `off`. |
| `GITHUB_CACHE_DIR` | 平台缓存目录 | 覆盖磁盘缓存位置. |
| `GITHUB_MCP_TIMEOUT_MS` | `30000` | 单次请求超时 (毫秒). |
| `GITHUB_MCP_MAX_FILE_BYTES` | `262144` | 内容工具返回文本的最大长度, 超出即截断. |
| `GITHUB_MCP_EXPOSE_IDENTITY` | 未设置 | 显式开启: `1`/`true`/`yes`/`on` 让 `github_rate_limit` 追加 `authenticated_as` 和 `scopes`; 其他取值保持关闭. |
| `GITHUB_MCP_LOG` | `error` | 会被解析和校验; 目前未使用 - 警告始终写入 stderr, 与级别无关. |

无效值会被忽略, 在 stderr 上给出警告, 然后使用默认值.

## 工具一览

Agent 会通过 `tools/list` 拿到每个工具的完整输入 schema, 这里只列名字. 分组与 `github_capabilities` 返回的索引一致.

- Meta: `github_capabilities` (每条摘要带关键输入契约, 每个工具带输入签名), `github_rate_limit` (通过 `GITHUB_MCP_EXPOSE_IDENTITY` 显式开启身份输出), `github_api_get` (对 api.github.com 的任意只读 GET; `path` 可带查询串, `query` 接受标量值; 不支持 GraphQL)
- Repository: `github_repo` (报告 `visibility`), `github_branches`
- Files: `github_tree` (默认最多返回 `max_entries` 1000 条, 附 `total_entries`, 类型 `summary` 和 `api_truncated`), `github_file` (支持从 1 开始的 `start_line`/`end_line` 行区间)
- History: `github_commits`
- Collaboration: `github_issue`, `github_issues`, `github_pr`, `github_prs`
- Releases: `github_release`, `github_releases`
- Snapshot: `github_repo_health`, `github_compare_repos` (一次调用对最多 20 个仓库做限速的横向对比)
- Search: `github_search_repos` (每条结果报告 `private` 和 `visibility`; `public_only` 默认为 `true` — 传 `false` 才包含私有仓库 — 在本地过滤并报告 `filtered_count`, `total_count` 保持 GitHub 的未过滤总数), `github_search_code` (需要 token), `github_search_issues`
- Actions: `github_workflows`, `github_workflow_runs`, `github_workflow_run`

## 故障排查

| 现象 | 含义 | 怎么办 |
| --- | --- | --- |
| 403/429, `rate_limited` | 当前凭据的配额用尽 | 调用 `github_rate_limit`, 等待它报告的重置时间 |
| raw 或 API 主机 DNS/连接失败 | 这个网络到 GitHub 的链路不可靠 | 设置 `GITHUB_PROXY` 或 `HTTPS_PROXY` |
| `auth_missing` | 该端点需要 token; `github_search_code` 必须有 token | 设置 `GITHUB_TOKEN` 或 `GH_TOKEN` |
| `not_found` | 仓库, ref, 路径或 release tag 不存在, 或是私有仓库 | 检查 `owner/name` 和 ref |
| TLS 错误 | TLS 拦截 (企业 MITM) 或代理链路损坏 | 把 `GITHUB_PROXY` 或 `HTTPS_PROXY` 指向可用的代理, 或尝试 `GITHUB_PROXY_MODE=direct` |

## 开发

- `npm test`: 运行测试套件
- `npm run typecheck`: 运行严格 TypeScript 检查
- `npm run build`: 编译生产构建
- `npm run smoke`: 通过 stdio 启动构建产物, 断言 22 个工具全部列出
- `GITHUB_SMOKE=1 npm test`: 带着 `GITHUB_SMOKE` 运行测试套件; 该变量目前是预留变量, 未被使用

## 许可证

MIT. Copyright (c) 2026 Kurv Cygnus. 详见 [LICENSE](LICENSE).
