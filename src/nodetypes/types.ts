import type {
  EffectiveStatus,
  LifecycleStatus,
  Node,
  NodeType,
  ValidationIssue,
} from "../core/types.ts";

export interface LinkedRef {
  cid: string;
  fallback: string;
  meta?: Record<string, unknown>;
}

export interface RelationshipDef {
  name: string;
  links: LinkedRef[];
}

export interface NodeMeta {
  severity: string | null;
  framework_name: string | null;
  language: string | null;
  runtime_name: string | null;
}

export interface NodeTypeModule {
  nodeType: NodeType;
  plural: string;
  schemaFile: string;
  description: string;
  template?: (publicKey: string) => Record<string, unknown>;
  title(node: Node): string | null;
  meta(node: Node): NodeMeta;
  lifecycle(declared: LifecycleStatus, verified: boolean): EffectiveStatus;
  relationshipNames: string[];
  relationships(node: Node): RelationshipDef[];
  linkedCids(node: Node, relationship: string): string[];
  crossFieldChecks(node: Node): ValidationIssue[];
}
