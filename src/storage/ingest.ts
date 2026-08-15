import { validateNode } from "../schema/validate.ts";
import { verifyNodeSignature } from "../core/sign.ts";
import { canonicalBytes } from "../core/serialize.ts";
import type {
  Node,
  ValidationIssue,
  VerificationPayload,
} from "../core/types.ts";
import { isVerification } from "../nodetypes/registry.ts";
import type { Blockstore } from "./blockstore.ts";
import type { NodeStore } from "./node_store.ts";
import type { IndexedNode } from "./types.ts";
import type { PlaygroundRegistry } from "../execution/registry.ts";
import {
  type ReplayExecutor,
  type ReplayResult,
  StubReplayExecutor,
} from "../execution/replay.ts";

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

export function compareReplay(
  suite: TestSuite,
  result: ReplayResult,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const pointer = "/payload/verification/execution/test_suite";
  if (result.outcome !== "pass") {
    issues.push({
      pointer,
      message: `replay outcome is ${result.outcome}, expected pass`,
    });
  }
  if (result.total !== suite.total) {
    issues.push({
      pointer,
      message:
        `replay total ${result.total} does not match claimed total ${suite.total}`,
    });
  }
  if (result.passed !== suite.passed) {
    issues.push({
      pointer,
      message:
        `replay passed ${result.passed} does not match claimed passed ${suite.passed}`,
    });
  }
  if (result.failed !== suite.failed) {
    issues.push({
      pointer,
      message:
        `replay failed ${result.failed} does not match claimed failed ${suite.failed}`,
    });
  }
  const claimed = new Map(suite.cases.map((c) => [c.name, c.result]));
  const replayed = new Map(result.cases.map((c) => [c.name, c.result]));
  if (
    claimed.size !== replayed.size ||
    [...claimed].some(([name, res]) => replayed.get(name) !== res)
  ) {
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
  #store: NodeStore;
  #registry: PlaygroundRegistry | null;
  #replay: ReplayExecutor;

  constructor(
    blockstore: Blockstore,
    store: NodeStore,
    registry: PlaygroundRegistry | null = null,
    replay: ReplayExecutor = new StubReplayExecutor(),
  ) {
    this.#blockstore = blockstore;
    this.#store = store;
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
      const existing = await this.#store.getNode(cid);
      if (existing) {
        return existing;
      }
      return await this.#store.indexNode(node, cid, new Date().toISOString());
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
    if (!isVerification(node)) {
      throw new ValidationError([{
        pointer: "/osk/node_type",
        message: "node must be a Verification node",
      }]);
    }
    const verification = node.payload.verification;
    if (
      this.#registry &&
      !this.#registry.lookup(verification.execution.environment_hash)
    ) {
      throw new ValidationError([{
        pointer: "/payload/verification/execution/environment_hash",
        message:
          "environment hash is not registered in the playground registry",
      }]);
    }
    const precheck = await this.#store.precheckVerification(node);
    if (precheck.length > 0) {
      throw new ValidationError(precheck);
    }
    if (this.#replay.enforced) {
      const solution = await this.#store.getNode(
        node.payload.verification.target.solution_id["/"],
      );
      const problem = await this.#store.getNode(
        node.payload.verification.target.problem_id["/"],
      );
      const env = this.#registry?.lookup(
        node.payload.verification.execution.environment_hash,
      );
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
      const issues = compareReplay(
        node.payload.verification.execution.test_suite,
        result,
      );
      if (issues.length > 0) {
        throw new ValidationError(issues);
      }
    }
    const cid = await this.#blockstore.put(canonicalBytes(node));
    try {
      if (!await this.#store.hasVerification(cid)) {
        await this.#store.addVerification(node, cid, new Date().toISOString());
      }
    } catch (e) {
      await this.#blockstore.delete(cid).catch(() => {});
      throw e;
    }
    return { cid, node };
  }
}
