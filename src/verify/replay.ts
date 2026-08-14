import type { Node } from "../core/types.ts";
import type { EnvSpec } from "./registry.ts";

export interface ReplayCase {
  name: string;
  result: string;
}

export interface ReplayResult {
  outcome: "pass" | "fail" | "error";
  total: number;
  passed: number;
  failed: number;
  log: string;
  cases: ReplayCase[];
}

export interface ReplayExecutor {
  readonly enforced: boolean;
  replay(solution: Node, problem: Node, env: EnvSpec): Promise<ReplayResult>;
}

export class StubReplayExecutor implements ReplayExecutor {
  readonly enforced = false;

  async replay(_solution: Node, _problem: Node, _env: EnvSpec): Promise<ReplayResult> {
    return await Promise.resolve({
      outcome: "pass",
      total: 1,
      passed: 1,
      failed: 0,
      log: "replay stub: real sandbox execution is post-MVP",
      cases: [{ name: "stub", result: "pass" }],
    });
  }
}

export class SandboxReplayExecutor implements ReplayExecutor {
  readonly enforced = true;
  #cmd: string[];

  constructor(cmd: string[]) {
    this.#cmd = cmd;
  }

  async replay(solution: Node, problem: Node, env: EnvSpec): Promise<ReplayResult> {
    const input = JSON.stringify({ solution, problem, env });
    const command = new Deno.Command(this.#cmd[0]!, {
      args: this.#cmd.slice(1),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = command.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    const { stdout } = await child.output();
    const text = new TextDecoder().decode(stdout);
    try {
      const parsed = JSON.parse(text) as Partial<ReplayResult>;
      return {
        outcome: parsed.outcome ?? "error",
        total: parsed.total ?? 0,
        passed: parsed.passed ?? 0,
        failed: parsed.failed ?? 0,
        log: parsed.log ?? "",
        cases: Array.isArray(parsed.cases) ? parsed.cases as ReplayCase[] : [],
      };
    } catch {
      return {
        outcome: "error",
        total: 0,
        passed: 0,
        failed: 0,
        log: `sandbox produced non-JSON output: ${text.slice(0, 200)}`,
        cases: [],
      };
    }
  }
}
