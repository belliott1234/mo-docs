// The operator's private settings: `config.json` in the state directory.
// It holds no mo key. mo keys live only in state.db.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type Config = {
  /** Where the connector listens for mo's calls. Put your own https in front. */
  listen: { host: string; port: number };
  /**
   * The public https origin that reaches `listen`, such as
   * "https://agent.example.com". Left null, mo makes no calls and the
   * connector relies on its regular check alone.
   */
  publicUrl: string | null;
  /** The regular check. It is required even when mo calls: see the guide. */
  checkEverySeconds: number;
  agent: {
    /** An absolute path. Started directly, never through a shell. */
    command: string;
    args: string[];
    timeoutSeconds: number;
    /** Names of environment variables your agent needs, passed through as they are. */
    passEnv: string[];
  };
  /**
   * Messages addressed to another agent or to the other side only.
   * "skip": your agent has no instruction to act on those; they are completed
   * unseen. "hand_over": your agent sees them and decides.
   */
  notForYourSide: "skip" | "hand_over";
  /** Files larger than this are listed for the agent and not downloaded. */
  maxDownloadBytes: number;
  /** Only for the packet's own tests, which shorten the waits. Leave it out. */
  timings?: Record<string, number | number[]>;
};

export const CONFIG_TEMPLATE: Config = {
  listen: { host: "127.0.0.1", port: 8787 },
  publicUrl: null,
  checkEverySeconds: 300,
  agent: {
    command: "/absolute/path/to/your/agent-hook",
    args: [],
    timeoutSeconds: 300,
    passEnv: [],
  },
  notForYourSide: "skip",
  maxDownloadBytes: 25 * 1024 * 1024,
};

const fail = (message: string): never => {
  throw new Error(`config.json: ${message}`);
};

export function loadConfig(directory: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
  } catch {
    return fail("missing or not JSON. Run `init` first.");
  }
  const input = raw as Partial<Config>;
  const config: Config = {
    ...CONFIG_TEMPLATE,
    ...input,
    listen: { ...CONFIG_TEMPLATE.listen, ...input.listen },
    agent: { ...CONFIG_TEMPLATE.agent, ...input.agent },
  };
  const { agent, listen } = config;
  if (typeof agent.command !== "string" || !isAbsolute(agent.command))
    fail("agent.command must be an absolute path.");
  if (
    !Array.isArray(agent.args) ||
    agent.args.some((value) => typeof value !== "string")
  )
    fail("agent.args must be a list of strings.");
  if (
    !Array.isArray(agent.passEnv) ||
    agent.passEnv.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
  )
    fail("agent.passEnv must be a list of variable names.");
  if (!(agent.timeoutSeconds >= 1 && agent.timeoutSeconds <= 3600))
    fail("agent.timeoutSeconds must be 1 to 3600.");
  if (!Number.isInteger(listen.port) || listen.port < 0 || listen.port > 65535)
    fail("listen.port is not a port.");
  if (!(config.checkEverySeconds >= 60 && config.checkEverySeconds <= 3600))
    fail("checkEverySeconds must be 60 to 3600.");
  if (!["skip", "hand_over"].includes(config.notForYourSide))
    fail('notForYourSide must be "skip" or "hand_over".');
  if (config.publicUrl !== null) {
    let url: URL | undefined;
    try {
      url = new URL(config.publicUrl);
    } catch {
      fail("publicUrl is not an address.");
    }
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url!.hostname);
    if (url!.protocol !== "https:" && !local) fail("publicUrl must be https.");
    config.publicUrl = url!.origin;
  }
  return config;
}
