#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_NAME = "@kurvcygnus/github-fetcher";
const VERSION = "0.2.0";
const TOOL_COUNT = 22;
const INSTALL = "npx -y @kurvcygnus/github-fetcher@latest";

const EN_HEADINGS = [
  "## Built for mainland China networks",
  "## Comparison with the official server",
  "## Limitations",
];
const ZH_HEADINGS = [
  "## 为中国大陆网络而构建",
  "## 与官方 server 的对比",
  "## 限制",
];

export async function verifyLaunch({ root = process.cwd(), offline = true } = {}) {
  const errors = [];
  const read = async (relative) => {
    try {
      return await readFile(join(root, relative), "utf8");
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : null;
      errors.push(code === "ENOENT" ? `missing file: ${relative}` : `cannot read ${relative}: ${code ?? error}`);
      return "";
    }
  };
  const parse = (text, relative) => {
    try {
      return JSON.parse(text);
    } catch {
      errors.push(`invalid JSON: ${relative}`);
      return {};
    }
  };

  const pkg = parse(await read("package.json"), "package.json");
  if (pkg.name !== PACKAGE_NAME) errors.push(`package.json name must be ${PACKAGE_NAME}`);
  if (pkg.version !== VERSION) errors.push(`package.json version must be ${VERSION}`);
  if (pkg.mcpName !== "io.github.KurvCygnus/github-fetcher") errors.push("package.json mcpName is missing or wrong");
  for (const file of ["dist", "README.md", "README.zh-CN.md", "LICENSE", "CHANGELOG.md"]) {
    if (!Array.isArray(pkg.files) || !pkg.files.includes(file)) errors.push(`package.json files missing ${file}`);
  }
  if (pkg.scripts?.["verify:launch"] !== "node scripts/verify-launch.mjs") {
    errors.push("package.json verify:launch script is missing");
  }

  const versionSource = await read("src/core/version.ts");
  const versionMatch = versionSource.match(/VERSION = "([^"]+)"/);
  if (versionMatch?.[1] !== VERSION) errors.push(`src/core/version.ts must be ${VERSION}`);

  const registrySource = await read("src/tools/registry.ts");
  const countMatch = registrySource.match(/EXPECTED_TOOL_COUNT = (\d+)/);
  if (Number(countMatch?.[1]) !== TOOL_COUNT) errors.push(`EXPECTED_TOOL_COUNT must be ${TOOL_COUNT}`);

  const en = await read("README.md");
  const zh = await read("README.zh-CN.md");
  for (const heading of EN_HEADINGS) if (!en.includes(heading)) errors.push(`README.md missing heading: ${heading}`);
  for (const heading of ZH_HEADINGS) if (!zh.includes(heading)) errors.push(`README.zh-CN.md missing heading: ${heading}`);
  if (!en.includes(INSTALL)) errors.push("README.md missing install command");
  if (!zh.includes(INSTALL)) errors.push("README.zh-CN.md missing install command");
  if (!zh.includes("https://github.com/KurvCygnus/github-fetcher/blob/main/README.zh-CN.md")) {
    errors.push("README.zh-CN.md missing absolute self link");
  }
  for (const [name, text] of [["README.md", en], ["README.zh-CN.md", zh]]) {
    const tools = new Set([...text.matchAll(/\bgithub_[a-z0-9_]+\b/g)].map((match) => match[0]));
    if (tools.size !== TOOL_COUNT) errors.push(`${name} lists ${tools.size} tools, expected ${TOOL_COUNT}`);
    if (/\b(?!22\b)\d+\s+tools?\b/.test(text) || /\b(?!22\b)\d+\s*个工具/.test(text)) {
      errors.push(`${name} has stale tool count`);
    }
    for (const marker of ["TODO", "TBD", "FIXME", "example.com"]) {
      if (text.includes(marker)) errors.push(`${name} contains placeholder ${marker}`);
    }
  }

  const changelog = await read("CHANGELOG.md");
  if (!changelog.includes("## [0.2.0]")) errors.push("CHANGELOG.md missing 0.2.0 section");
  await read("SECURITY.md");
  await read("CONTRIBUTING.md");

  const server = parse(await read("server.json"), "server.json");
  if (server.name !== pkg.mcpName) errors.push("server.json name must match package.json mcpName");
  if (server.version !== VERSION) errors.push(`server.json version must be ${VERSION}`);
  const entry = server.packages?.[0];
  if (entry?.identifier !== PACKAGE_NAME) errors.push("server.json package identifier is wrong");
  if (entry?.version !== VERSION) errors.push("server.json package version is wrong");
  if (entry?.transport?.type !== "stdio") errors.push("server.json transport must be stdio");

  if (!offline) {
    const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    let fetchImpl = fetch;
    let dispatcher;
    if (proxy) {
      const { ProxyAgent, fetch: proxyFetch } = await import("undici");
      dispatcher = new ProxyAgent(proxy);
      fetchImpl = proxyFetch;
    }
    try {
      for (const link of [
        { url: "https://github.com/KurvCygnus/github-fetcher" },
        { url: "https://registry.npmjs.org/@kurvcygnus%2Fgithub-fetcher", json: true },
      ]) {
        try {
          const response = await fetchImpl(link.url, {
            method: "GET",
            redirect: "follow",
            headers: { "User-Agent": "github-fetcher-launch-check" },
            signal: AbortSignal.timeout(10000),
            ...(dispatcher ? { dispatcher } : {}),
          });
          if (!response.ok) {
            errors.push(`link ${link.url} returned ${response.status}`);
            continue;
          }
          if (link.json) {
            const data = await response.json();
            if (data.name !== PACKAGE_NAME) {
              errors.push(`link ${link.url} returned package ${String(data.name)}`);
            }
          }
        } catch (error) {
          errors.push(`link ${link.url} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      await dispatcher?.close();
    }
  }

  return { ok: errors.length === 0, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await verifyLaunch({
    root: process.cwd(),
    offline: !process.argv.includes("--online"),
  });
  if (!result.ok) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("LAUNCH VERIFY OK");
  }
}
