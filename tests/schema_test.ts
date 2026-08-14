import { assertEquals } from "@std/assert";
import { validateNode } from "../src/schema/validate.ts";
import type { Node, ProblemPayload, VerificationPayload } from "../src/core/types.ts";

function baseNode(overrides: Partial<Node<ProblemPayload>> = {}): Node<ProblemPayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Problem",
      node_id: "0190c0a0-0000-7000-8000-000000000001",
      knowledge_lifecycle: {
        status: "draft",
        last_verified: "2026-08-14T00:00:00Z",
      },
      attribution: {
        author_type: "agent",
        public_key: "a".repeat(64),
      },
    },
    payload: {
      problem: {
        title: "A very real problem",
        severity: "high",
        symptoms: [
          {
            type: "error_message",
            description: "process exits",
            observable: "exit code 1",
            frequency: "always",
          },
        ],
        root_cause: {
          mechanism: "null deref",
          causal_chain: ["memory", "pointer"],
        },
        environment: {
          runtime: { type: "node", versions: ["22.x"] },
          framework: { name: "deno", version: "2.x" },
        },
      },
    },
    ...overrides,
  };
}

function verificationNode(
  overrides: Partial<VerificationPayload> = {},
): Node<VerificationPayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Verification",
      node_id: "0190c0a0-0000-7000-8000-000000000002",
      knowledge_lifecycle: {
        status: "active",
        last_verified: "2026-08-14T00:00:00Z",
      },
      attribution: {
        author_type: "agent",
        public_key: "b".repeat(64),
      },
    },
    payload: {
      verification: {
        target: {
          problem_id: { "/": "b".repeat(61) },
          solution_id: { "/": "b".repeat(61) },
        },
        execution: {
          playground: "sandbox-den",
          environment_hash: "c".repeat(64),
          test_suite: {
            total: 1,
            passed: 1,
            failed: 0,
            cases: [
              {
                name: "basic",
                expected: "ok",
                actual: "ok",
                result: "pass",
              },
            ],
          },
        },
        timestamp: "2026-08-14T00:00:00Z",
      },
      ...overrides,
    },
  };
}

Deno.test("valid Problem passes validation", async () => {
  assertEquals(await validateNode(baseNode()), []);
});

Deno.test("empty payload fails validation", async () => {
  const issues = await validateNode({ osk: baseNode().osk, payload: {} });
  assertEquals(issues.length > 0, true);
});

Deno.test("title over 120 chars fails", async () => {
  const node = baseNode();
  node.payload.problem.title = "x".repeat(121);
  const issues = await validateNode(node);
  assertEquals(issues.some((i) => i.pointer.includes("title")), true);
});

Deno.test("missing symptoms fails", async () => {
  const node = baseNode();
  node.payload.problem.symptoms = [];
  const issues = await validateNode(node);
  assertEquals(issues.some((i) => i.pointer.includes("symptoms")), true);
});

Deno.test("invalid severity enum fails", async () => {
  const node = baseNode();
  node.payload.problem.severity = "catastrophic" as never;
  const issues = await validateNode(node);
  assertEquals(issues.some((i) => i.pointer.includes("severity")), true);
});

Deno.test("wrong osk.version fails", async () => {
  const node = baseNode();
  node.osk = { ...node.osk, version: "0.2.0" } as unknown as Node["osk"];
  const issues = await validateNode(node);
  assertEquals(issues.length > 0, true);
});

Deno.test("node_type mismatch with payload fails", async () => {
  const node = baseNode();
  node.osk.node_type = "Recipe" as never;
  const issues = await validateNode(node);
  assertEquals(issues.length > 0, true);
});

Deno.test("valid Verification passes validation", async () => {
  assertEquals(await validateNode(verificationNode()), []);
});

Deno.test("verification total != passed+failed fails", async () => {
  const node = verificationNode();
  node.payload.verification.execution.test_suite.total = 2;
  const issues = await validateNode(node);
  assertEquals(
    issues.some((i) => i.message.includes("total")),
    true,
  );
});

Deno.test("verification total != cases.length fails", async () => {
  const node = verificationNode();
  node.payload.verification.execution.test_suite.total = 0;
  node.payload.verification.execution.test_suite.passed = 0;
  const issues = await validateNode(node);
  assertEquals(
    issues.some((i) => i.message.includes("cases.length")),
    true,
  );
});

Deno.test("verification without cases fails", async () => {
  const node = verificationNode();
  node.payload.verification.execution.test_suite.cases = [];
  const issues = await validateNode(node);
  assertEquals(issues.some((i) => i.pointer.includes("cases")), true);
});

Deno.test("verification with invalid env hash fails", async () => {
  const node = verificationNode();
  node.payload.verification.execution.environment_hash = "not-hex";
  const issues = await validateNode(node);
  assertEquals(issues.some((i) => i.pointer.includes("environment_hash")), true);
});

Deno.test("ipld link with non-CID string fails", async () => {
  const node = verificationNode();
  node.payload.verification.target.problem_id = { "/": "not-a-cid" };
  const issues = await validateNode(node);
  assertEquals(issues.some((i) => i.pointer.includes("problem_id")), true);
});
