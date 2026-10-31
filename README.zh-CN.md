[English](README.md) | [简体中文](README.zh-CN.md)

# @kurvcygnus/github-fetcher

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520.18-blue)

AI 编码 agent 的日常工作几乎全在读 GitHub, 而直连 GitHub 的读取路径既不安全也不省钱, 更谈不上可靠. `@kurvcygnus/github-fetcher` 是一个只读的 GitHub MCP server: 它通过 stdio 暴露 20 个工具, 走 GitHub REST API 读取仓库, 文件, commit, issue, pull request, release, 仓库健康, Actions 和搜索结果. 它复用你已有的凭据, 能绕开不可靠的网络, 把响应缓存到磁盘, 并且无法修改任何东西.

## 问题所在

Agent 访问 GitHub 的频率极高 (读目录树, 读文件, 查 issue, 查 pull request, 看 CI), 而直连访问会以各种方式失败, 浪费所有人的时间:

- 匿名 REST 访问的配额是每 IP 每小时 60 次请求, 由机器上的所有工具共享.
- GitHub 会用 403 拒绝没有 `User-Agent` 头的请求, 裸脚本因此报错, 且原因很难察觉.
- 在 `raw.githubusercontent.com` 被 DNS 污染的网络 (中国大陆很常见) 上, raw 文件抓取直接失败.
- 为了只读工作给 agent 配一个带写权限的 token 是不必要的风险.
- 没有共享缓存时, 每个工具都会重复抓取同样的内容.

## 你能得到什么

- 通过 stdio 暴露的 20 个只读 MCP 工具: 仓库, 目录树, 文件, commit, 分支, issue, pull request, release, 仓库健康, 搜索, Actions 运行记录, 以及一个通用的只读 GET 兜底工具.
- 复用 git credential store 里的 token: 服务器读取你的 git credential helper 已保存的凭据 (例如 GitHub CLI 或 Git Credential Manager), 不会在磁盘上新增秘密. `GITHUB_TOKEN` 优先; 完全没有 token 时退回匿名访问 (每小时 60 次请求).
- 为恶劣网络设计的代理路由: `auto` 模式下 API 请求先直连, `raw.githubusercontent.com` 请求先走代理; 可用 `always` 和 `direct` 覆盖. 代理候选按顺序尝试: `GITHUB_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, 然后是 git 的代理配置.
- 能在重启后存活的 ETag 磁盘缓存: 未超过 TTL 的条目直接本地返回, 过期条目用 `If-None-Match`/`If-Modified-Since` 廉价重验证, 收到 304 就复用已存的响应体, 不再重新下载.
- 速率限制处理: 短窗口 (15 秒以内) 自动等待一次后重试; 长窗口则报错并给出精确的重置时间.

## 快速开始

把对应的条目加进你客户端的 MCP 配置.

OpenCode:

```json
{
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "-y", "@kurvcygnus/github-fetcher"],
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
      "args": ["-y", "@kurvcygnus/github-fetcher"],
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
      "args": ["-y", "@kurvcygnus/github-fetcher"]
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
      "args": ["-y", "@kurvcygnus/github-fetcher"]
    }
  }
}
```

四个客户端运行的是同一条命令; 在客户端支持的位置加一个带 `GITHUB_TOKEN` 的 `env` 块, 或者在启动客户端的 shell 里 export 这个变量.

## CLI

每个工具同时也是同一个二进制的子命令 - 适合 shell 管道, 也适合在没有 agent 参与的情况下查看数据.

全局安装 (`npm i -g @kurvcygnus/github-fetcher`) 后会同时注册短别名 `ghf`, `ghf rate KurvCygnus/github-fetcher` 同样可用.

    github-fetcher releases anomalyco/opencode --per-page 5 | jq -r ".items[].tag_name"
    github-fetcher health anthropics/claude-code --window-days 30 --pretty
    github-fetcher file KurvCygnus/github-fetcher README.md

- 直接运行 `github-fetcher` (或 `serve`) 启动 MCP stdio server; 带子命令则走 CLI.
- stdout 输出紧凑 JSON (`--pretty` 输出缩进格式, 适合人类阅读); 错误以 JSON 写到 stderr, 退出码: 2 用法, 3 速率限制, 4 认证, 5 未找到, 6 网络, 7 上游.
- `--help` 列出子命令; `github-fetcher <subcommand> --help` 显示单个工具的参数.

## 安全模型

- 从构造上只读: 服务器只发出 GET 请求; 不支持 GraphQL 和写操作, `github_api_get` 接受任意只读 GET 路径, 主机固定为 api.github.com.
- 只会联系两个主机: API 请求只到 `api.github.com`, raw 字节只来自 `raw.githubusercontent.com`.
- 重定向被限制在 GitHub origin 之内: 离开原主机的重定向会被拒绝.
- Token 只出现在 Authorization 头里, 绝不进入日志, 错误信息, 工具输出或缓存; 缓存键使用 token 的 SHA-256 哈希.
- 缓存文件以 0600 权限写入 (尽力而为), 位置在用户自己的缓存目录下.

## 工作原理

每次工具调用都会变成一次针对 GitHub REST API 的 GET 请求. 请求先经过缓存层: 未超过端点 TTL 的条目直接本地返回, 过期条目用 ETag 重验证; 只有成功的响应才会进缓存, 所以 not-found 响应永远不会被缓存, 每次都以 `not_found` 错误呈现. 除 `github_rate_limit` 和 `github_api_get` 外, 每个工具都接受 `fresh` 选项, 为单次请求绕过缓存. 缓存之下, HTTP 层为每个请求选择路由, 重试传输失败, 自动等过短的速率限制窗口, 并在 token 被拒时刷新一次再放弃.

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
| `GITHUB_MCP_LOG` | `error` | 会被解析和校验; 目前未使用 — 警告始终写入 stderr, 与级别无关. |

无效值会被忽略, 在 stderr 上给出警告, 然后使用默认值.

## 工具一览

Agent 会通过 `tools/list` 拿到每个工具的完整输入 schema, 这里只列名字.

- 配额: `github_rate_limit`
- 仓库: `github_repo`, `github_tree`, `github_file`, `github_commits`, `github_branches`
- Issue 与 pull request: `github_issue`, `github_issues`, `github_pr`, `github_prs`
- Release: `github_release`, `github_releases`
- 仓库健康: `github_repo_health`
- 搜索: `github_search_repos`, `github_search_code` (需要 token), `github_search_issues`
- Actions: `github_workflows`, `github_workflow_runs`, `github_workflow_run`
- 兜底: `github_api_get` (对 api.github.com 的任意只读 GET; 不支持 GraphQL)

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
- `npm run smoke`: 通过 stdio 启动构建产物, 断言 20 个工具全部列出
- `GITHUB_SMOKE=1 npm test`: 带着 `GITHUB_SMOKE` 运行测试套件; 该变量目前是预留变量, 未被使用

## 许可证

MIT. Copyright (c) 2026 Kurv Cygnus. 详见 [LICENSE](LICENSE).
