import type {
  DeprecationTrigger,
  GuidePayload,
  Node,
  ProblemPayload,
  RecipePayload,
  VerificationPayload,
} from "../src/core/types.ts";
import { uuidv7 } from "../src/core/uuidv7.ts";
import { signNode } from "../src/core/sign.ts";
import { computeCid } from "../src/core/cid.ts";

export function problemNode(
  pubKey: string,
  options: {
    supersedesCid?: string;
    nodeId?: string;
    title?: string;
    solutionCids?: string[];
  } = {},
): Node<ProblemPayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Problem",
      node_id: options.nodeId ?? uuidv7(),
      ...(options.supersedesCid
        ? { supersedes_cid: { "/": options.supersedesCid } }
        : {}),
      knowledge_lifecycle: {
        status: "active",
        last_verified: "2026-08-14T00:00:00Z",
      },
      attribution: { author_type: "agent", public_key: pubKey },
    },
    payload: {
      problem: {
        title: options.title ?? "Process crashes on large input",
        severity: "high",
        symptoms: [
          {
            type: "runtime_behavior",
            description: "process exits unexpectedly",
            observable: "exit code 1 above 10k records",
            frequency: "intermittent",
          },
        ],
        root_cause: {
          mechanism: "stack overflow from recursion",
          causal_chain: ["recursion", "stack", "crash"],
        },
        environment: {
          runtime: { type: "node", versions: ["22.x"] },
          framework: { name: "deno", version: "2.x" },
        },
        ...(options.solutionCids
          ? {
            solutions: options.solutionCids.map((c) => ({ node: { "/": c } })),
          }
          : {}),
      },
    },
  };
}

export function recipeNode(
  pubKey: string,
  options: { deprecationTriggers?: DeprecationTrigger[] } = {},
): Node<RecipePayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Recipe",
      node_id: uuidv7(),
      knowledge_lifecycle: {
        status: "active",
        last_verified: "2026-08-14T00:00:00Z",
        ...(options.deprecationTriggers
          ? { deprecation_triggers: options.deprecationTriggers }
          : {}),
      },
      attribution: { author_type: "agent", public_key: pubKey },
    },
    payload: {
      recipe: {
        title: "Replace recursion with an explicit stack",
        code: {
          language: "typescript",
          framework: "deno",
          body:
            "const stack = [root]; while (stack.length) { const n = stack.pop(); }",
        },
        explanation: "An explicit stack avoids the call stack limit.",
      },
    },
  };
}

export function verificationNode(
  pubKey: string,
  problemCid: string,
  solutionCid: string,
  envHash: string,
  overrides: Partial<VerificationPayload["verification"]> = {},
): Node<VerificationPayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Verification",
      node_id: uuidv7(),
      knowledge_lifecycle: {
        status: "active",
        last_verified: "2026-08-14T00:00:00Z",
      },
      attribution: { author_type: "agent", public_key: pubKey },
    },
    payload: {
      verification: {
        target: {
          problem_id: { "/": problemCid },
          solution_id: { "/": solutionCid },
        },
        execution: {
          playground: "sandbox-den",
          environment_hash: envHash,
          test_suite: {
            total: 2,
            passed: 2,
            failed: 0,
            cases: [
              { name: "small", expected: "ok", actual: "ok", result: "pass" },
              { name: "large", expected: "ok", actual: "ok", result: "pass" },
            ],
          },
        },
        timestamp: "2026-08-14T00:00:00Z",
        ...overrides,
      },
    },
  };
}

export function guideNode(
  pubKey: string,
  options: { nodeId?: string } = {},
): Node<GuidePayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Guide",
      node_id: options.nodeId ?? uuidv7(),
      knowledge_lifecycle: {
        status: "active",
        last_verified: "2026-08-14T00:00:00Z",
      },
      attribution: { author_type: "agent", public_key: pubKey },
    },
    payload: {
      guide: {
        title: "Iterating without blowing the call stack",
        epistemic_status: "verified",
        sections: [
          {
            heading: "Why recursion overflows",
            claim: "Deep recursion exceeds the default call stack.",
            depth: "beginner",
            verification: {
              type: "demonstration",
              demonstration_cid: { "/": "b".repeat(61) },
              playground_receipt: { "/": "b".repeat(61) },
              result: "confirmed",
            },
          },
        ],
      },
    },
  };
}

export function signed(node: Node, secretKeyHex: string): Node {
  return signNode(node, secretKeyHex);
}

export async function cidOf(node: Node): Promise<string> {
  return await computeCid(node);
}
