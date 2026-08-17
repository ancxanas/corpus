import type {
  BlueprintPayload,
  ComparisonPayload,
  DeprecationTrigger,
  GuidePayload,
  ImprovementPayload,
  Node,
  ProblemPayload,
  RecipePayload,
  ReferencePayload,
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
          runtime: { type: "deno", versions: ["2.x"] },
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
  options: {
    deprecationTriggers?: DeprecationTrigger[];
    nodeId?: string;
    supersedesCid?: string;
    title?: string;
  } = {},
): Node<RecipePayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Recipe",
      node_id: options.nodeId ?? uuidv7(),
      ...(options.supersedesCid
        ? { supersedes_cid: { "/": options.supersedesCid } }
        : {}),
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
        title: options.title ?? "Replace recursion with an explicit stack",
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
            body: {
              explanation:
                "Each recursive call reserves stack space, so deep recursion exhausts the default stack.",
            },
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

export function referenceNode(
  pubKey: string,
  options: { nodeId?: string; title?: string } = {},
): Node<ReferencePayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Reference",
      node_id: options.nodeId ?? uuidv7(),
      knowledge_lifecycle: {
        status: "active",
        last_verified: "2026-08-14T00:00:00Z",
      },
      attribution: { author_type: "agent", public_key: pubKey },
    },
    payload: {
      reference: {
        title: options.title ?? "Deno fetch API reference",
        topic: "deno",
        source: {
          type: "official_docs",
          url: "https://docs.deno.com/api",
          synced_at: "2026-08-14T00:00:00Z",
        },
        entries: [
          {
            name: "fetch",
            kind: "function",
            signature: "fetch(input): Promise<Response>",
            description: "Performs an HTTP request.",
            version: ">=2.0.0",
            source_pointer: "https://docs.deno.com/api#fetch",
          },
        ],
        consistency: {
          method: "agent_verification",
          last_checked: "2026-08-14T00:00:00Z",
          result: "confirmed",
        },
      },
    },
  };
}

export function comparisonNode(
  pubKey: string,
  options: {
    nodeId?: string;
    benchmarkReceiptCids?: string[];
  } = {},
): Node<ComparisonPayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Comparison",
      node_id: options.nodeId ?? uuidv7(),
      knowledge_lifecycle: {
        status: "active",
        last_verified: "2026-08-14T00:00:00Z",
      },
      attribution: { author_type: "agent", public_key: pubKey },
    },
    payload: {
      comparison: {
        title: "Deno vs Node for HTTP servers",
        decision_context: "Choose a server runtime for the ingest tier.",
        dimensions: [
          {
            name: "cold start latency",
            options: [
              {
                name: "deno",
                value: 12,
                ...(options.benchmarkReceiptCids?.[0]
                  ? {
                    benchmark_receipt: { "/": options.benchmarkReceiptCids[0] },
                  }
                  : {}),
              },
              {
                name: "node",
                value: 18,
                ...(options.benchmarkReceiptCids?.[1]
                  ? {
                    benchmark_receipt: { "/": options.benchmarkReceiptCids[1] },
                  }
                  : {}),
              },
            ],
          },
        ],
        recommendations: [
          {
            condition: "when cold start latency matters",
            choice: "deno",
            reason: "it boots fastest",
          },
        ],
      },
    },
  };
}

export function improvementNode(
  pubKey: string,
  options: {
    nodeId?: string;
    recipeCids?: string[];
  } = {},
): Node<ImprovementPayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Improvement",
      node_id: options.nodeId ?? uuidv7(),
      knowledge_lifecycle: {
        status: "active",
        last_verified: "2026-08-14T00:00:00Z",
      },
      attribution: { author_type: "agent", public_key: pubKey },
    },
    payload: {
      improvement: {
        title: "Migrate the ingest tier to streaming",
        current_state: {
          description: "Whole-file buffering.",
          metrics: { peak_memory_mb: 512 },
        },
        target_state: {
          description: "Row-by-row streaming.",
          expected_metrics: { peak_memory_mb: 64 },
        },
        rationale: "Large uploads exhaust memory.",
        implementation: {
          approach: "incremental",
          phases: [
            {
              phase: 1,
              title: "Stream the reader",
              effort: "M",
              ...(options.recipeCids
                ? {
                  recipe_links: options.recipeCids.map((c) => ({
                    node: { "/": c },
                    relation: "uses" as const,
                  })),
                }
                : {}),
            },
          ],
        },
        validation: {
          success_criteria: "peak memory under 64MB",
          verification_plan: "run the upload benchmark",
        },
      },
    },
  };
}

export function blueprintNode(
  pubKey: string,
  options: {
    nodeId?: string;
    relatedCids?: string[];
  } = {},
): Node<BlueprintPayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Blueprint",
      node_id: options.nodeId ?? uuidv7(),
      knowledge_lifecycle: {
        status: "active",
        last_verified: "2026-08-14T00:00:00Z",
      },
      attribution: { author_type: "agent", public_key: pubKey },
    },
    payload: {
      blueprint: {
        title: "Unify the runtime on Deno",
        current_landscape: {
          fragments: [
            {
              technology: "node",
              purpose: "API tier",
              limitations: ["large memory footprint"],
            },
          ],
          systemic_friction: "two runtimes to patch and secure",
        },
        proposed_architecture: {
          core_principle: "one runtime everywhere",
          layers: [
            {
              layer: 1,
              name: "edge",
              technology: "deno",
              responsibility: "route requests",
            },
          ],
        },
        rationale: ["one dependency graph", "single security surface"],
        feasibility: {
          blockers: [
            {
              issue: "migration cost",
              type: "implementation",
              severity: "medium",
            },
          ],
          enablers: ["shared permissions model"],
        },
        adoption_trajectory: {
          phase_1: "pilot the API tier",
          phase_2: "migrate the workers",
          phase_3: "retire node",
        },
        ...(options.relatedCids
          ? {
            related_nodes: options.relatedCids.map((c) => ({
              node: { "/": c },
              relation: "enables" as const,
            })),
          }
          : {}),
        epistemic_status: "feasible",
        confidence: "medium",
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
