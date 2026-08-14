import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { loadSchema } from "./index.ts";
import type { Node, NodeType } from "../core/types.ts";

export interface ValidationIssue {
  pointer: string;
  message: string;
}

const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false });
const compiled = new Map<NodeType, ValidateFunction>();
let defsReady: Promise<void> | null = null;

function loadDefs(): Promise<void> {
  defsReady ??= (async () => {
    const defs = JSON.parse(
      await Deno.readTextFile(new URL("./defs.json", import.meta.url)),
    );
    ajv.addSchema(defs, "corpus:defs");
  })();
  return defsReady;
}

async function compiler(nodeType: NodeType): Promise<ValidateFunction> {
  const existing = compiled.get(nodeType);
  if (existing) {
    return existing;
  }
  await loadDefs();
  const schema = await loadSchema(nodeType);
  const validate = ajv.compile(schema as never);
  compiled.set(nodeType, validate);
  return validate;
}

function toPointer(path: string | undefined): string {
  if (!path) {
    return "";
  }
  return path
    .replace(/~1/g, "/")
    .replace(/~0/g, "~")
    .split("/")
    .slice(1)
    .map((seg) => `/${seg}`)
    .join("")
    .replace(/\/+$/, "");
}

function toIssues(errors: ErrorObject[]): ValidationIssue[] {
  return errors.map((e) => ({
    pointer: toPointer(e.instancePath),
    message: e.message ?? "invalid",
  }));
}

function crossFieldIssues(node: Node): ValidationIssue[] {
  if (node.osk.node_type !== "Verification") {
    return [];
  }
  const verification = (node.payload as { verification: { execution: { test_suite: { total: number; passed: number; failed: number; cases: unknown[] } } } })
    .verification;
  const suite = verification.execution.test_suite;
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
  const failCount = suite.cases.filter((c) => (c as { result: string }).result === "fail").length;
  if (failCount !== suite.failed) {
    issues.push({
      pointer: "/payload/verification/execution/test_suite/failed",
      message: "failed must equal count of cases with result 'fail'",
    });
  }
  return issues;
}

export async function validateNode(node: unknown): Promise<ValidationIssue[]> {
  const nodeType = (node as Node).osk?.node_type as NodeType;
  if (!nodeType) {
    return [{ pointer: "/osk/node_type", message: "node_type is required" }];
  }
  const validate = await compiler(nodeType);
  const valid = validate(node);
  const issues: ValidationIssue[] = valid ? [] : toIssues(validate.errors ?? []);
  if (valid) {
    issues.push(...crossFieldIssues(node as Node));
  }
  return issues;
}
