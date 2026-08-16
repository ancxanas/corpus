export type NodeType =
  | "Problem"
  | "Recipe"
  | "Guide"
  | "Verification"
  | "Reference"
  | "Comparison"
  | "Improvement"
  | "Blueprint";

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

export interface Step {
  title: string;
  body: string;
  code?: string;
}

export interface AgentContext {
  model: string;
  context_window_size: number;
  context_window_used: number;
  tool_count: number;
  reasoning_chain_length: number;
}

export interface Measurement {
  name: string;
  value: number;
  unit?: string;
  description?: string;
}

export interface ProblemPayload {
  problem: {
    title: string;
    severity: "critical" | "high" | "medium" | "low";
    summary?: string;
    impact?: string;
    symptoms: Array<{
      type: "runtime_behavior" | "error_message" | "performance_degradation";
      description: string;
      observable: string;
      frequency: "always" | "intermittent" | "race_condition";
    }>;
    reproduction?: Step[];
    diagnosis?: Step[];
    root_cause: {
      mechanism: string;
      causal_chain: string[];
    };
    environment: {
      runtime: { type: string; versions: string[] };
      framework: { name: string; version: string };
      agent_context?: AgentContext;
    };
    solutions?: Array<{
      node: IpldLink;
      applies_to?: string;
    }>;
    tags?: string[];
    references?: Array<{ title: string; url: string }>;
  };
}

export interface RecipePayload {
  recipe: {
    title: string;
    summary?: string;
    code: {
      language: string;
      framework?: string;
      body: string;
    };
    explanation: string;
    prerequisites?: Array<{
      description: string;
      node?: IpldLink;
    }>;
    steps?: Step[];
    verification?: string;
    caveats?: Array<{
      condition: string;
      warning: string;
    }>;
    tags?: string[];
    references?: Array<{ title: string; url: string }>;
  };
}

export type GuideDepth = "beginner" | "intermediate" | "advanced";

export interface GuidePayload {
  guide: {
    title: string;
    summary?: string;
    epistemic_status: "verified" | "heuristic" | "draft";
    sections: Array<{
      heading: string;
      claim: string;
      body: {
        explanation: string;
        steps?: Step[];
        code?: {
          language: string;
          framework?: string;
          body: string;
        };
        example?: string;
      };
      depth: GuideDepth;
      verification: {
        type: "demonstration" | "source_attestation";
        demonstration_cid?: IpldLink;
        attested_source?: string;
        playground_receipt?: IpldLink;
        result: "confirmed" | "unconfirmed";
      };
    }>;
    prerequisites?: Array<{
      node: IpldLink;
      required_depth?: GuideDepth;
    }>;
    caveats?: Array<{
      condition: string;
      warning: string;
    }>;
    references?: Array<{ title: string; url: string }>;
    tags?: string[];
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
        measurements?: Measurement[];
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
    agent_context?: AgentContext;
  };
}

export interface Node<T = unknown> {
  osk: Osk;
  payload: T;
}

export interface ReferencePayload {
  reference: {
    title: string;
    topic: string;
    source: {
      type: "official_docs" | "specification" | "source_code" | "vendor_docs";
      url?: string;
      snapshot_cid?: IpldLink;
      synced_at?: string;
    };
    entries: Array<{
      name: string;
      kind: "function" | "type" | "flag" | "config" | "behavior";
      signature?: string | null;
      description: string;
      version: string;
      source_pointer: string;
    }>;
    consistency: {
      method: "source_sync" | "manual" | "agent_verification";
      last_checked: string;
      result: "confirmed" | "drifted";
    };
  };
}

export interface ComparisonPayload {
  comparison: {
    title: string;
    decision_context: string;
    dimensions: Array<{
      name: string;
      options: Array<{
        name: string;
        value: number | string;
        benchmark_receipt?: IpldLink;
      }>;
    }>;
    recommendations: Array<{
      condition: string;
      choice: string;
      reason: string;
    }>;
  };
}

export interface ImprovementPayload {
  improvement: {
    title: string;
    current_state: {
      description: string;
      metrics: Record<string, number>;
    };
    target_state: {
      description: string;
      expected_metrics: Record<string, number>;
    };
    rationale: string;
    implementation: {
      approach: "incremental" | "big_bang" | "parallel";
      phases: Array<{
        phase: number;
        title: string;
        effort: string;
        recipe_links?: Array<{
          node: IpldLink;
          relation: "uses" | "requires" | "replaces";
        }>;
      }>;
    };
    trade_offs?: Array<{
      aspect: string;
      downside: string;
      mitigation: string;
    }>;
    validation: {
      success_criteria?: string;
      verification_plan?: string;
      benchmark_receipts?: IpldLink[];
    };
  };
}

export interface BlueprintPayload {
  blueprint: {
    title: string;
    current_landscape: {
      fragments: Array<{
        technology: string;
        purpose: string;
        limitations: string[];
      }>;
      systemic_friction: string;
    };
    proposed_architecture: {
      core_principle: string;
      layers: Array<{
        layer: number;
        name: string;
        technology: string;
        responsibility: string;
      }>;
    };
    rationale: string[];
    feasibility: {
      blockers: Array<{
        issue: string;
        type: "implementation" | "social" | "economic" | "political";
        severity: "high" | "medium" | "low";
      }>;
      enablers: string[];
    };
    adoption_trajectory?: {
      phase_1: string;
      phase_2: string;
      phase_3: string;
    };
    related_nodes?: Array<{
      node: IpldLink;
      relation: "comparison" | "prerequisite" | "solves" | "enables";
    }>;
    epistemic_status:
      | "vision"
      | "feasible"
      | "in_progress"
      | "realized"
      | "abandoned";
    confidence: "high" | "medium" | "low";
  };
}

export interface ValidationIssue {
  pointer: string;
  message: string;
}
