export type NodeType =
  | "Problem"
  | "Recipe"
  | "Verification";

export type LifecycleStatus = "active" | "deprecated" | "disputed" | "draft";
export type EffectiveStatus =
  | "draft"
  | "active"
  | "stale"
  | "disputed"
  | "deprecated";

export interface IpldLink {
  "/": string;
}

export interface DeprecationTrigger {
  type: "framework_version" | "language_spec" | "runtime_change";
  scope: string;
  versioning_scheme?: "semver" | "calver" | "year" | "custom";
  condition: string;
}

export interface Attribution {
  author_type: "agent" | "human" | "hybrid";
  public_key: string;
  signature?: string;
}

export interface Osk {
  version: "0.3.0";
  node_type: NodeType;
  node_id: string;
  supersedes_cid?: IpldLink;
  knowledge_lifecycle: {
    status: LifecycleStatus;
    last_verified: string;
    deprecation_triggers?: DeprecationTrigger[];
  };
  attribution: Attribution;
}

export interface ProblemPayload {
  problem: {
    title: string;
    severity: "critical" | "high" | "medium" | "low";
    symptoms: Array<{
      type: "runtime_behavior" | "error_message" | "performance_degradation";
      description: string;
      observable: string;
      frequency: "always" | "intermittent" | "race_condition";
    }>;
    root_cause: {
      mechanism: string;
      causal_chain: string[];
    };
    environment: {
      runtime: { type: string; versions: string[] };
      framework: { name: string; version: string };
      agent_context?: {
        model: string;
        context_window_size: number;
        context_window_used: number;
        tool_count: number;
        reasoning_chain_length: number;
      };
    };
    solutions?: Array<{
      node: IpldLink;
      applies_to?: string;
    }>;
  };
}

export interface RecipePayload {
  recipe: {
    title: string;
    code: {
      language: string;
      framework?: string;
      body: string;
    };
    explanation: string;
    caveats?: Array<{
      condition: string;
      warning: string;
    }>;
  };
}

export interface VerificationPayload {
  verification: {
    target: {
      problem_id: IpldLink;
      solution_id: IpldLink;
    };
    execution: {
      playground: string;
      environment_hash: string;
      test_suite: {
        total: number;
        passed: number;
        failed: number;
        cases: Array<{
          name: string;
          input_cid?: IpldLink;
          expected: string;
          actual: string;
          result: "pass" | "fail";
        }>;
      };
    };
    timestamp: string;
    valid_until?: string;
  };
}

export interface Node<T = unknown> {
  osk: Osk;
  payload: T;
}
