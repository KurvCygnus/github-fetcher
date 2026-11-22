import { homedir } from "node:os";
import { join } from "node:path";

//* The platform and home parameters let tests resolve config paths without
//* touching the real user profile; production callers rely on the defaults.
export function daemonConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") return env.APPDATA ?? join(home, "AppData", "Roaming");
  if (platform === "darwin") return join(home, "Library", "Application Support");
  return env.XDG_CONFIG_HOME ?? join(home, ".config");
}

export function daemonStatePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return join(daemonConfigDir(env, platform, home), "github-fetcher", "daemon.json");
}

export function daemonTokenPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return join(daemonConfigDir(env, platform, home), "github-fetcher", "token");
}
