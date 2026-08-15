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

export interface DeclaredTestSuite {
  total: number;
  passed: number;
  failed: number;
  cases: { name: string; result: string }[];
}

export interface ReplayExecutor {
  readonly enforced: boolean;
  readonly label: string;
  replay(
    solution: Node,
    problem: Node,
    env: EnvSpec,
    declared?: DeclaredTestSuite,
  ): Promise<ReplayResult>;
}

export class StubReplayExecutor implements ReplayExecutor {
  readonly enforced = false;
  readonly label = "stub";

  async replay(
    _solution: Node,
    _problem: Node,
    _env: EnvSpec,
    _declared?: DeclaredTestSuite,
  ): Promise<ReplayResult> {
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

export class TrustedStubReplayExecutor implements ReplayExecutor {
  readonly enforced = true;
  readonly label = "trusted-stub";

  async replay(
    _solution: Node,
    _problem: Node,
    _env: EnvSpec,
    declared?: DeclaredTestSuite,
  ): Promise<ReplayResult> {
    const suite = declared ?? { total: 1, passed: 1, failed: 0, cases: [] };
    return await Promise.resolve({
      outcome: "pass",
      total: suite.total,
      passed: suite.passed,
      failed: suite.failed,
      log: "trusted-stub replay: the operator vouches for the claimed suite",
      cases: suite.cases.map((c) => ({ name: c.name, result: c.result })),
    });
  }
}

export class SandboxReplayExecutor implements ReplayExecutor {
  readonly enforced = true;
  readonly label = "sandbox";
  readonly #cmd: string[];
  readonly #timeoutMs: number;

  constructor(cmd: string[], timeoutMs = 30_000) {
    if (cmd.length === 0 || cmd[0]!.trim() === "") {
      throw new Error("sandbox command must not be empty");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `sandbox timeout must be a positive integer, got ${timeoutMs}`,
      );
    }
    this.#cmd = cmd;
    this.#timeoutMs = timeoutMs;
  }

  async replay(
    solution: Node,
    problem: Node,
    env: EnvSpec,
    _declared?: DeclaredTestSuite,
  ): Promise<ReplayResult> {
    const input = JSON.stringify({ solution, problem, env });
    const command = new Deno.Command(this.#cmd[0]!, {
      args: this.#cmd.slice(1),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = command.spawn();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, this.#timeoutMs);
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    try {
      const { stdout } = await child.output();
      if (timedOut) {
        return {
          outcome: "error",
          total: 0,
          passed: 0,
          failed: 0,
          log: `sandbox exceeded the ${this.#timeoutMs}ms timeout`,
          cases: [],
        };
      }
      const text = new TextDecoder().decode(stdout);
      try {
        const parsed = JSON.parse(text) as Partial<ReplayResult>;
        return {
          outcome: parsed.outcome ?? "error",
          total: parsed.total ?? 0,
          passed: parsed.passed ?? 0,
          failed: parsed.failed ?? 0,
          log: parsed.log ?? "",
          cases: Array.isArray(parsed.cases)
            ? parsed.cases as ReplayCase[]
            : [],
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
    } catch (e) {
      return {
        outcome: "error",
        total: 0,
        passed: 0,
        failed: 0,
        log: `sandbox execution failed: ${(e as Error).message}`,
        cases: [],
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
