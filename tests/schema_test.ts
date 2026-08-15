import { assertEquals } from "@std/assert";
import { validateNode } from "../src/schema/validate.ts";
import type {
  GuidePayload,
  Node,
  ProblemPayload,
  RecipePayload,
  Step,
  VerificationPayload,
} from "../src/core/types.ts";

function baseNode(
  overrides: Partial<Node<ProblemPayload>> = {},
): Node<ProblemPayload> {
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

function recipeNode(
  overrides: Partial<RecipePayload> = {},
): Node<RecipePayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Recipe",
      node_id: "0190c0a0-0000-7000-8000-000000000003",
      knowledge_lifecycle: {
        status: "active",
        last_verified: "2026-08-14T00:00:00Z",
      },
      attribution: {
        author_type: "agent",
        public_key: "c".repeat(64),
      },
    },
    payload: {
      recipe: {
        title: "A very real recipe",
        code: {
          language: "typescript",
          framework: "deno",
          body: "return 42;",
        },
        explanation: "It just works.",
      },
      ...overrides,
    },
  };
}

function guideNode(
  overrides: Partial<GuidePayload> = {},
): Node<GuidePayload> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Guide",
      node_id: "0190c0a0-0000-7000-8000-000000000004",
      knowledge_lifecycle: {
        status: "active",
        last_verified: "2026-08-14T00:00:00Z",
      },
      attribution: {
        author_type: "agent",
        public_key: "d".repeat(64),
      },
    },
    payload: {
      guide: {
        title: "A very real guide",
        epistemic_status: "verified",
        sections: [
          {
            heading: "How it works",
            claim: "Streaming keeps memory bounded.",
            body: {
              explanation:
                "Reading the input row by row means only one row is ever alive at once.",
              steps: [
                {
                  title: "Open a reader",
                  body: "Read chunks incrementally.",
                  code: "const reader = file.readable.getReader();",
                },
              ],
              code: {
                language: "typescript",
                framework: "deno",
                body: "for (const row of rows) parse(row);",
              },
              example: "A 500MB upload stays under 64MB of resident memory.",
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
  assertEquals(
    issues.some((i) => i.pointer.includes("environment_hash")),
    true,
  );
});

Deno.test("ipld link with non-CID string fails", async () => {
  const node = verificationNode();
  node.payload.verification.target.problem_id = { "/": "not-a-cid" };
  const issues = await validateNode(node);
  assertEquals(issues.some((i) => i.pointer.includes("problem_id")), true);
});

Deno.test("problem with detail fields passes", async () => {
  const node = baseNode();
  node.payload.problem.summary = "An overview.";
  node.payload.problem.impact = "Everything breaks.";
  node.payload.problem.reproduction = [
    { title: "Run it", body: "Do the thing." },
  ];
  node.payload.problem.diagnosis = [
    { title: "Check it", body: "Look at the logs." },
  ];
  node.payload.problem.tags = ["networking", "dns"];
  node.payload.problem.references = [
    { title: "RFC", url: "https://example.com/rfc" },
  ];
  assertEquals(await validateNode(node), []);
});

Deno.test("problem reproduction step missing body fails", async () => {
  const node = baseNode();
  node.payload.problem.reproduction = [
    { title: "Run it" } as Step,
  ];
  const issues = await validateNode(node);
  assertEquals(
    issues.some((i) => i.pointer.includes("reproduction")),
    true,
  );
});

Deno.test("valid Recipe passes validation", async () => {
  assertEquals(await validateNode(recipeNode()), []);
});

Deno.test("recipe with detail fields passes", async () => {
  const node = recipeNode();
  node.payload.recipe.summary = "An overview.";
  node.payload.recipe.prerequisites = [
    {
      description: "Read the guide.",
      node: { "/": "b".repeat(61) },
    },
  ];
  node.payload.recipe.steps = [
    { title: "Step one", body: "Do it.", code: "await run();" },
  ];
  node.payload.recipe.verification = "Run the smoke test.";
  node.payload.recipe.tags = ["typescript"];
  node.payload.recipe.references = [
    { title: "Docs", url: "https://example.com/docs" },
  ];
  assertEquals(await validateNode(node), []);
});

Deno.test("recipe step missing title fails", async () => {
  const node = recipeNode();
  node.payload.recipe.steps = [{ body: "Do it." } as Step];
  const issues = await validateNode(node);
  assertEquals(issues.some((i) => i.pointer.includes("steps")), true);
});

Deno.test("valid Guide passes validation", async () => {
  assertEquals(await validateNode(guideNode()), []);
});

Deno.test("guide missing epistemic_status fails", async () => {
  const node = guideNode();
  const guide = node.payload.guide as
    & { epistemic_status?: string }
    & Record<
      string,
      unknown
    >;
  delete guide.epistemic_status;
  const issues = await validateNode(node);
  assertEquals(
    issues.some((i) => i.message.includes("epistemic_status")),
    true,
  );
});

Deno.test("guide without sections fails", async () => {
  const node = guideNode();
  node.payload.guide.sections = [];
  const issues = await validateNode(node);
  assertEquals(issues.some((i) => i.pointer.includes("sections")), true);
});

Deno.test("heuristic guide without caveats fails", async () => {
  const node = guideNode();
  node.payload.guide.epistemic_status = "heuristic";
  const issues = await validateNode(node);
  assertEquals(
    issues.some((i) => i.message.includes("caveats")),
    true,
  );
});

Deno.test("verified guide with source attestation fails", async () => {
  const node = guideNode();
  node.payload.guide.epistemic_status = "verified";
  const section = node.payload.guide.sections[0]!;
  section.verification.type = "source_attestation";
  section.verification.attested_source = "https://example.com/spec";
  const issues = await validateNode(node);
  assertEquals(
    issues.some((i) => i.message.includes("caps the guide")),
    true,
  );
});

Deno.test("verified claim without playground receipt fails", async () => {
  const node = guideNode();
  delete node.payload.guide.sections[0]!.verification.playground_receipt;
  const issues = await validateNode(node);
  assertEquals(
    issues.some((i) => i.message.includes("playground_receipt")),
    true,
  );
});

Deno.test("source attestation without attested source fails", async () => {
  const node = guideNode();
  const section = node.payload.guide.sections[0]!;
  node.payload.guide.epistemic_status = "heuristic";
  section.verification.type = "source_attestation";
  node.payload.guide.caveats = [
    { condition: "on unusual setups", warning: "verify manually" },
  ];
  const issues = await validateNode(node);
  assertEquals(
    issues.some((i) => i.message.includes("attested_source")),
    true,
  );
});
