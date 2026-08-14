import { validateNode, type ValidationIssue } from "../schema/validate.ts";
import { verifyNodeSignature } from "../core/sign.ts";
import { canonicalBytes } from "../core/serialize.ts";
import type { Node, VerificationPayload } from "../core/types.ts";
import type { Blockstore } from "./blockstore.ts";
import type { QueryIndex } from "./index.ts";
import type { IndexedNode } from "./types.ts";
import type { PlaygroundRegistry } from "../verify/registry.ts";
import { StubReplayExecutor, type ReplayExecutor, type ReplayResult } from "../verify/replay.ts";

export class ValidationError extends Error {
  issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues[0]?.message ?? "node validation failed");
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export class SignatureError extends Error {
  constructor() {
    super("invalid node signature");
    this.name = "SignatureError";
  }
}

export class ReplayUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayUnavailableError";
  }
}

type TestSuite = VerificationPayload["verification"]["execution"]["test_suite"];

export function compareReplay(suite: TestSuite, result: ReplayResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const pointer = "/payload/verification/execution/test_suite";
  if (result.outcome !== "pass") {
    issues.push({
      pointer,
      message: `replay outcome is ${result.outcome}, expected pass`,
    });
  }
  if (result.total !== suite.total) {
    issues.push({ pointer, message: `replay total ${result.total} does not match claimed total ${suite.total}` });
  }
  if (result.passed !== suite.passed) {
    issues.push({ pointer, message: `replay passed ${result.passed} does not match claimed passed ${suite.passed}` });
  }
  if (result.failed !== suite.failed) {
    issues.push({ pointer, message: `replay failed ${result.failed} does not match claimed failed ${suite.failed}` });
  }
  const claimed = new Map(suite.cases.map((c) => [c.name, c.result]));
  const replayed = new Map(result.cases.map((c) => [c.name, c.result]));
  if (claimed.size !== replayed.size || [...claimed].some(([name, res]) => replayed.get(name) !== res)) {
    issues.push({
      pointer: `${pointer}/cases`,
      message: "replay cases do not match the claimed test suite",
    });
  }
  return issues;
}

export interface IngestResult {
  cid: string;
  node: Node;
}

export class IngestService {
  #blockstore: Blockstore;
  #index: QueryIndex;
  #registry: PlaygroundRegistry | null;
  #replay: ReplayExecutor;

  constructor(
    blockstore: Blockstore,
    index: QueryIndex,
    registry: PlaygroundRegistry | null = null,
    replay: ReplayExecutor = new StubReplayExecutor(),
  ) {
    this.#blockstore = blockstore;
    this.#index = index;
    this.#registry = registry;
    this.#replay = replay;
  }

  async ingestNode(node: Node): Promise<IndexedNode> {
    const issues = await validateNode(node);
    if (issues.length > 0) {
      throw new ValidationError(issues);
    }
    if (!verifyNodeSignature(node)) {
      throw new SignatureError();
    }
    const cid = await this.#blockstore.put(canonicalBytes(node));
    try {
      const existing = this.#index.getNode(cid);
      if (existing) {
        return existing;
      }
      return this.#index.indexNode(node, cid, new Date().toISOString());
    } catch (e) {
      await this.#blockstore.delete(cid).catch(() => {});
      throw e;
    }
  }

  async ingestVerification(node: Node): Promise<IngestResult> {
    const issues = await validateNode(node);
    if (issues.length > 0) {
      throw new ValidationError(issues);
    }
    if (!verifyNodeSignature(node)) {
      throw new SignatureError();
    }
    const verification = (node.payload as { verification: { execution: { environment_hash: string } } })
      .verification;
    if (this.#registry && !this.#registry.lookup(verification.execution.environment_hash)) {
      throw new ValidationError([{
        pointer: "/payload/verification/execution/environment_hash",
        message: "environment hash is not registered in the playground registry",
      }]);
    }
    const precheck = this.#index.precheckVerification(node);
    if (precheck.length > 0) {
      throw new ValidationError(precheck);
    }
    if (this.#replay.enforced) {
      const verification = (node.payload as VerificationPayload).verification;
      const solution = this.#index.getNode(verification.target.solution_id["/"]);
      const problem = this.#index.getNode(verification.target.problem_id["/"]);
      const env = this.#registry?.lookup(verification.execution.environment_hash);
      if (!solution || !problem || !env) {
        throw new ReplayUnavailableError(
          "verification execution unavailable: missing target node or environment",
        );
      }
      let result: ReplayResult;
      try {
        result = await this.#replay.replay(solution.node, problem.node, env);
      } catch {
        throw new ReplayUnavailableError("verification execution unavailable");
      }
      const issues = compareReplay(verification.execution.test_suite, result);
      if (issues.length > 0) {
        throw new ValidationError(issues);
      }
    }
    const cid = await this.#blockstore.put(canonicalBytes(node));
    try {
      if (!this.#index.hasVerification(cid)) {
        this.#index.addVerification(node, cid, new Date().toISOString());
      }
    } catch (e) {
      await this.#blockstore.delete(cid).catch(() => {});
      throw e;
    }
    return { cid, node };
  }
}
