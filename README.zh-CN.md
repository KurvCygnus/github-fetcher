[English](https://github.com/KurvCygnus/github-fetcher/blob/main/README.md) | [简体中文](https://github.com/KurvCygnus/github-fetcher/blob/main/README.zh-CN.md)

# @kurvcygnus/github-fetcher

[![npm version](https://img.shields.io/npm/v/@kurvcygnus/github-fetcher.svg)](https://www.npmjs.com/package/@kurvcygnus/github-fetcher)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.19-blue)
[![M8ven Trust](https://m8ven.ai/badge/mcp/kurvcygnus/github-fetcher)](https://m8ven.ai/mcp/kurvcygnus/github-fetcher?s=readme)

`@kurvcygnus/github-fetcher` 是一个只读的 GitHub MCP server, 提供 44 个工具, 一条命令完成客户端配置, 可选的单例 loopback daemon, 以及诚实的配额与成本元数据. 它复用你已有的凭据, 能应对恶劣网络, 把响应缓存到磁盘, 并且无法修改任何东西.

## 为什么选它

- **从构造上只读.** 每个工具只发 GET 请求. 官方 server 提供写工具, 需要 `--read-only` 才能移除它们.
- **客户端配置里没有 token.** `init` 写入不含秘密的条目; 凭据来自 git credential store 或环境变量. 官方本地 server 要求每个主机配置 PAT 或 OAuth 登录.
- **为恶劣网络而构建.** API 先直连, API 和 raw 字节都有代理回退, ETag 磁盘缓存, 有界重试. 不需要 Docker 或 Go 工具链.
- **一个本地进程服务所有会话.** 可选的 loopback daemon 用一个 Node 进程承载多个 MCP 会话, 凭据与 pin 按会话隔离; stdio 客户端保持不变. 官方本地 server 对每个 stdio 客户端各跑一个进程, 或者改用托管远端 server.
- **一条命令配置你已有的客户端.** `init` 检测八种客户端, 预览路径, 修改前备份每个文件, 确认后才写入. 官方文档提供按主机划分的片段和安装按钮.
- **成本与限制可见.** 每个响应都带缓存和配额元数据; 字节上限和超时让截断显式发生, 而不是静默发生.
- **搜索调查一气呵成.** 仓库, 用户, 代码和 issue 搜索与 label 发现, 仓库体检, release diff 以及有界的跨仓快照放在一起, agent 用几次调用就能交叉验证一个问题, 不必手工拼接裸端点.

## 为中国大陆网络而构建

GitHub 匿名 REST 配额是**每个出口 IP 每小时 60 次**, 由机器上的所有工具共享. `raw.githubusercontent.com` 经常被 DNS 污染, 缺少 `User-Agent` 的裸 HTTP 请求会直接收到 403. 这个 server 围绕这些故障设计:

- 复用 git credential store 里已有的 token; `GITHUB_TOKEN` 和 `GH_TOKEN` 优先.
- API 先直连, 失败后走代理. 读文件时先用 contents API 取元数据和内联内容, GitHub 不返回内联正文时再经代理从 `raw.githubusercontent.com` 取.
- 每条路由对传输失败重试两次, 15 秒以内的限流窗口自动等待, 更长窗口报告精确重置时间.
- 成功响应带 ETag 缓存到磁盘, 重复读取不消耗配额.

不在中国大陆时默认配置同样可用; 设置 `GITHUB_PROXY_MODE=direct` 可以完全跳过代理尝试.

## 快速开始

运行一条命令, 然后跟随向导:

    npx -y @kurvcygnus/github-fetcher@latest init

向导会为八种支持的客户端写入 MCP 条目, 并在修改每个文件前备份. 已经指向本包的现有条目会原地更新. stdio 无需进一步设置; 使用 HTTP 的客户端启动一次 daemon:

    github-fetcher daemon start

全局安装 (`npm i -g @kurvcygnus/github-fetcher`) 后还会注册短别名 `ghf`. 每个工具同时也是 CLI 子命令, 不用 agent 也能查数据:

    ghf labels facebook/react --per-page 100 --with-counts
    ghf release-diff facebook/react v19.3.0 v19.3.1 --include-commits
    ghf batch-activity oven-sh/bun denoland/deno nodejs/node --window-days 30 --top-n 5

手动写入客户端条目的方法见文末附录.

## Agent 工作流

下面几条短路径说明这些工具的用途, 同样的调用既支持 MCP, 也支持 CLI 子命令.

**排查仓库.** 用 `github_labels` 列出真实 label 名称, 再把精确 label 传给 `github_issues`, 用 `github_issue` 看单条报告. `github_repo_health` 补充时间窗内的 issue, pull request 和 release 计数.

**还原 release.** `github_release_diff` 一次调用就返回两个 ref 之间的变更文件和 commit 列表. 某个 commit 需要完整补丁和文件列表时再用 `github_commit`, 用 `github_releases` 找到值得比较的 tag.

**对比项目.** `github_batch_activity` 一次生成多个仓库的有界快照, 包含开放 issue 与 pull request 数, 近期 commit 数, CI 结论分布和核心贡献者占比. `github_compare_repos` 适合更宽的仓库元数据对比.

**安全读代码.** `github_tree` 按字节裁剪大目录树, 支持 `glob` 和 `path_prefix`. `github_file` 与 `github_files` 遵守单次调用的字节预算, `github_file_grep` 在工作线程里做有界正则匹配. 用 `github_pin_ref` 把整次调查锚定到同一个 commit.

## 传输与会话模型

stdio 是默认传输, 无需任何配置. 使用 HTTP 的客户端连接 loopback daemon, 它默认在 `http://127.0.0.1:41873/mcp` 上提供同样的 44 个工具. 设置 `GITHUB_MCP_DAEMON_PORT` 可修改端口.

    github-fetcher daemon start
    github-fetcher daemon status
    github-fetcher daemon stop

`daemon start` 是幂等的. 它会在 `<user config dir>/github-fetcher/` 下写入状态文件和同目录的 token 文件; `daemon stop` 请求停止端点并删除这两个文件. `daemon status` 报告 pid, 端口, 版本, 会话数和运行时间. 访问 `/mcp`, `/health` 和 `POST /daemon/stop` 都需要 `Authorization: Bearer <token>` 头.

`github-fetcher init --transport http` 会启动 daemon, 并写入一条 OpenCode remote MCP 条目, 从 token 文件读取 bearer token, 因此客户端配置里不会出现秘密. 其他适配器没有 remote 条目, 会被跳过并给出警告.

凭据和 ref pin 按会话隔离. 一个会话的 token 或 pin 不会泄漏到另一个会话; 其余所有设置都来自 daemon 的环境变量.

## CLI

每个工具都是同一个二进制的子命令. stdout 输出紧凑 JSON (`--pretty` 适合人类阅读), 错误以 JSON 写到 stderr, 退出码为 2 用法, 3 速率限制, 4 认证, 5 未找到, 6 网络, 7 上游. 用 `--help` 查看子命令列表, 用 `<subcommand> --help` 查看单个工具的参数.

`init` 和 `remove` 管理客户端配置. `init` 支持 `--client id,id`, `--all`, `--dry-run` 和 `--name`; `remove` 支持 `--client`, `--all` 和 `--name`. 两者都会在写入前备份文件, 并在 stdout 输出一个 JSON 结果数组, 交互式提示走 stderr. 支持的客户端: `opencode`, `claude-desktop`, `claude-code`, `cursor`, `vscode`, `gemini`, `windsurf`, `codex`. ZCode 有意不支持.

## 工具一览

Agent 通过 `tools/list` 拿到每个工具的完整输入 schema. `github_capabilities` 携带同一套事实派生的输入行, 索引与 schema 不会漂移. 分组与它返回的索引一致.

- Meta: `github_capabilities`, `github_rate_limit`, `github_api_get`, `github_doctor`, `github_pin_ref` — 能力索引与分组过滤, 配额投影, 带守卫的 GET 兜底, 自检和会话 pin.
- Repository: `github_repo`, `github_repos`, `github_compare_refs`, `github_branches`, `github_languages`, `github_contributors`, `github_repo_activity`, `github_stargazers` — 仓库元数据, 批量查询, ref 与仓库对比, 语言和贡献者分布, 时间窗活跃度以及 star 时间线.
- User: `github_user`, `github_user_repos`, `github_user_starred`, `github_user_events`, `github_user_health` — 用户主页, 仓库, star 记录, 公开事件和一次调用完成的用户体检.
- Files: `github_tree`, `github_file`, `github_readme`, `github_file_grep`, `github_files` — 按字节裁剪且支持 glob 的目录树, 带行区间的文件读取, README 解析, 有界正则搜索和批量读取.
- History: `github_commits`, `github_commit` — 支持从最早或最新开始的 commit 遍历与消息截断, 以及带受限补丁的单条 commit 详情.
- Collaboration: `github_issue`, `github_issues`, `github_pr`, `github_prs`, `github_labels` — issue, pull request 和用于过滤的精确 label 发现.
- Releases: `github_release`, `github_releases`, `github_release_diff` — 单个 release, release 列表, 以及带受限补丁和 commit 投影的两 ref 对比.
- Snapshot: `github_repo_health`, `github_compare_repos`, `github_batch_activity` — 仓库体检, 限速的宽范围对比和有界的跨仓活跃度快照.
- Search: `github_search_repos`, `github_search_users`, `github_search_code`, `github_search_issues`, `github_trending` — 仓库, 用户, 代码和 issue 搜索, 附带诚实的字段投影, 以及基于搜索的趋势视角.
- Actions: `github_workflows`, `github_workflow_runs`, `github_workflow_run` — workflow 定义, 运行记录以及带 job 的单次运行详情.

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
| 一条命令配置多客户端 | 是 | 没有内置向导 |

官方 server 的信息按 2026-11-01 的 README 核对.

## 安全模型

- 从构造上只读: 服务器只发出 GET 请求; 不支持 GraphQL 和写操作. `github_api_get` 只有在传入 `ihaveto: true`, 确认没有专用工具覆盖该端点后, 才接受任意只读 GET 路径.
- 只会联系两个主机: API 请求只到 `api.github.com`, raw 字节只来自 `raw.githubusercontent.com`.
- 重定向被限制在 GitHub origin 之内; 离开原主机的重定向会被拒绝.
- Token 只出现在 Authorization 头里, 绝不进入日志, 错误信息, 工具输出或缓存. 缓存键使用 token 的 SHA-256 哈希.
- 缓存文件以 0600 权限尽力写入, 位置在用户自己的缓存目录下.
- 身份默认私密. `GITHUB_MCP_EXPOSE_IDENTITY` 让 `github_rate_limit` 和 `github_doctor` 追加 `authenticated_as` 和 `scopes`; 无论开关, token 和它的指纹都不会返回.

## 工作原理

每次工具调用都会变成一次针对 GitHub REST API 的 GET 请求.

- 成功结果只携带 `structuredContent`, `content` 数组保持为空, 只认文本的客户端不会为重复渲染付出代价. 错误结果把同一份紧凑 JSON 同时放进 `structuredContent` 和 `content` 文本块.
- 缓存层直接返回未过期的条目, 用 ETag 重验证过期条目, 并且永不缓存 not-found 响应. 每个读取 API 的工具都接受 `fresh` 做单次绕过.
- 每个走网络的响应都以 `meta: {cache, age_s, quota}` 结尾. 可选的 `calls` 字段统计客户端调用次数, 包括缓存命中和内部 ref 解析; 缓存温热命中仍报告 `calls: 1`. 配额消耗以 GitHub 的 used 计数为准.
- `github_pin_ref` 在会话内存里把仓库 pin 到一个 commit sha. 锚定读取回显 `pinned_sha`, 显式传入 `ref` 则不回显. `github_doctor` 在 `pinned_repos` 中列出当前会话的 pin.
- 缓存之下, HTTP 层为每个请求选择路由, 重试传输失败, 自动等过短的速率限制窗口, 并在 token 被拒时刷新一次再放弃.

`stdio 或 loopback HTTP MCP → tool registry → GithubClient (ETag cache) → HttpClient (routing, proxy, retries) → GitHub REST`

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 未设置 | GitHub token, 最先尝试. |
| `GH_TOKEN` | 未设置 | `GITHUB_TOKEN` 未设置时的备用 token. |
| `GITHUB_PROXY` | 未设置 | 专用代理 URL (`http://` 或 `https://`), 优先于通用代理变量. |
| `GITHUB_PROXY_MODE` | `auto` | 代理路由: `auto`, `always` 或 `direct`. |
| `HTTPS_PROXY` | 未设置 | 通用 HTTPS 代理兜底. |
| `HTTP_PROXY` | 未设置 | 通用 HTTP 代理兜底, 在 `HTTPS_PROXY` 之后尝试. |
| `GITHUB_CACHE` | `disk` | 缓存后端: `disk`, `memory` 或 `off`. |
| `GITHUB_CACHE_DIR` | 平台缓存目录 | 覆盖磁盘缓存位置. |
| `GITHUB_MCP_DAEMON_PORT` | `41873` | loopback daemon 端口. |
| `GITHUB_MCP_TIMEOUT_MS` | `30000` | 单次请求超时 (毫秒). |
| `GITHUB_MCP_GREP_TIMEOUT_MS` | `2000` | 正则匹配的时间预算; 超时返回 `matches_truncated`. |
| `GITHUB_MCP_MAX_FILE_BYTES` | `262144` | 响应文本的字节上限, 超出即截断; 单次调用的 `max_bytes` 可进一步收紧. |
| `GITHUB_MCP_EXPOSE_IDENTITY` | 未设置 | `1`/`true`/`yes`/`on` 让 rate limit 与 doctor 输出身份字段. |
| `GITHUB_MCP_LOG` | `error` | 会被解析和校验, 目前未使用; 警告始终写入 stderr. |

无效值会被忽略, 在 stderr 上给出警告, 然后使用默认值.

## 限制

- 从构造上只读: 不支持写操作, GraphQL, clone 或 archive 工具.
- 44 个工具覆盖宽广的读取路径, 但这里不是完整的 GitHub API 客户端. 专用工具没覆盖的端点用 `github_api_get`, 并传 `ihaveto: true`.
- 匿名访问每小时 60 次; 代码搜索需要 token.
- 不内置代理; 请自备 HTTP(S) 代理.
- 缓存会把响应体写到磁盘; 共享账号无法接受这一点时不要使用.

## 故障排查

| 现象 | 含义 | 怎么办 |
| --- | --- | --- |
| 403/429, `rate_limited` | 当前凭据的配额用尽 | 调用 `github_rate_limit`, 等待它报告的重置时间 |
| raw 或 API 主机 DNS/连接失败 | 这个网络到 GitHub 的链路不可靠 | 设置 `GITHUB_PROXY` 或 `HTTPS_PROXY` |
| `auth_missing` | 该端点需要 token; 代码搜索必须有 token | 设置 `GITHUB_TOKEN` 或 `GH_TOKEN` |
| `not_found` | 仓库, ref, 路径或 release tag 不存在, 或是私有仓库 | 检查 `owner/name` 和 ref |
| TLS 错误 | TLS 拦截或代理链路损坏 | 把 `GITHUB_PROXY` 或 `HTTPS_PROXY` 指向可用代理, 或尝试 `GITHUB_PROXY_MODE=direct` |

## 手动客户端配置

`init` 会处理所有支持的客户端. 需要手动写入时, OpenCode 的标准 stdio 条目是:

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

其他客户端使用各自的顶层 MCP 键, 命令和参数相同. 运行 `github-fetcher init --dry-run` 可以看到你机器上已安装客户端对应的精确条目.

## 开发

- `npm test`: 运行测试套件
- `npm run typecheck`: 运行严格 TypeScript 检查
- `npm run build`: 编译生产构建
- `npm run smoke`: 通过 stdio 启动构建产物, 断言 44 个工具全部列出
- `npm run verify:launch`: 检查发布元数据与 README 一致性

## 许可证

MIT. Copyright (c) 2026 Kurv Cygnus. 详见 [LICENSE](LICENSE).
