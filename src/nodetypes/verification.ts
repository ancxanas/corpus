import type {
  Node,
  ValidationIssue,
  VerificationPayload,
} from "../core/types.ts";
import type { NodeTypeModule } from "./types.ts";

export function isVerification(
  node: Node,
): node is Node<VerificationPayload> {
  return node.osk.node_type === "Verification";
}

export const verificationModule: NodeTypeModule = {
  nodeType: "Verification",
  plural: "verifications",
  schemaFile: "verification.json",
  description:
    "Attestation that a recipe was tested in a specific environment.",
  title() {
    return null;
  },
  meta() {
    return { severity: null, framework_name: null };
  },
  lifecycle(declared) {
    return declared;
  },
  relationshipNames: ["target"],
  relationships(node) {
    if (!isVerification(node)) {
      return [];
    }
    const verification = node.payload.verification;
    return [{
      name: "target",
      links: [
        { cid: verification.target.problem_id["/"], fallback: "problems" },
        { cid: verification.target.solution_id["/"], fallback: "recipes" },
      ],
    }];
  },
  linkedCids(node, relationship) {
    if (!isVerification(node) || relationship !== "target") {
      return [];
    }
    const verification = node.payload.verification;
    return [
      verification.target.problem_id["/"],
      verification.target.solution_id["/"],
    ];
  },
  crossFieldChecks(node): ValidationIssue[] {
    if (!isVerification(node)) {
      return [];
    }
    const suite = node.payload.verification.execution.test_suite;
    const issues: ValidationIssue[] = [];
    if (suite.total !== suite.passed + suite.failed) {
      issues.push({
        pointer: "/payload/verification/execution/test_suite/total",
        message: "total must equal passed + failed",
      });
    }
    if (suite.total !== suite.cases.length) {
      issues.push({
        pointer: "/payload/verification/execution/test_suite/total",
        message: "total must equal cases.length",
      });
    }
    const failCount = suite.cases.filter((c) => c.result === "fail").length;
    if (failCount !== suite.failed) {
      issues.push({
        pointer: "/payload/verification/execution/test_suite/failed",
        message: "failed must equal count of cases with result 'fail'",
      });
    }
    return issues;
  },
};
