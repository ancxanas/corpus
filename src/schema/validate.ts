import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { loadSchema } from "./index.ts";
import type { Node, NodeType, ValidationIssue } from "../core/types.ts";
import { registry } from "../nodetypes/registry.ts";

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

export async function validateNode(node: unknown): Promise<ValidationIssue[]> {
  const nodeType = (node as Node).osk?.node_type as NodeType;
  if (!nodeType) {
    return [{ pointer: "/osk/node_type", message: "node_type is required" }];
  }
  const validate = await compiler(nodeType);
  const valid = validate(node);
  const issues: ValidationIssue[] = valid
    ? []
    : toIssues(validate.errors ?? []);
  if (valid) {
    issues.push(...registry[nodeType].crossFieldChecks(node as Node));
  }
  return issues;
}
