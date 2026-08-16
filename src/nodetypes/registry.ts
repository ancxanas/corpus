import type { NodeType } from "../core/types.ts";
import type { NodeTypeModule } from "./types.ts";
import { problemModule } from "./problem.ts";
import { recipeModule } from "./recipe.ts";
import { guideModule } from "./guide.ts";
import { verificationModule } from "./verification.ts";
import { referenceModule } from "./reference.ts";
import { comparisonModule } from "./comparison.ts";
import { improvementModule } from "./improvement.ts";
import { blueprintModule } from "./blueprint.ts";

export { isProblem } from "./problem.ts";
export { isRecipe } from "./recipe.ts";
export { isGuide } from "./guide.ts";
export { isVerification } from "./verification.ts";
export { isReference } from "./reference.ts";
export { isComparison } from "./comparison.ts";
export { isImprovement } from "./improvement.ts";
export { isBlueprint } from "./blueprint.ts";

export const registry: Record<NodeType, NodeTypeModule> = {
  Problem: problemModule,
  Recipe: recipeModule,
  Guide: guideModule,
  Verification: verificationModule,
  Reference: referenceModule,
  Comparison: comparisonModule,
  Improvement: improvementModule,
  Blueprint: blueprintModule,
};

export function pluralOf(nodeType: NodeType): string {
  return registry[nodeType].plural;
}

export function byPluralOrSingular(value: string): NodeType | null {
  for (const module of Object.values(registry)) {
    if (module.plural === value || module.nodeType === value) {
      return module.nodeType;
    }
  }
  return null;
}

export function plurals(): Set<string> {
  return new Set(Object.values(registry).map((module) => module.plural));
}

export function templateFor(slug: string): NodeTypeModule | null {
  const needle = slug.toLowerCase();
  for (const module of Object.values(registry)) {
    if (
      module.nodeType.toLowerCase() === needle || module.plural === needle
    ) {
      return module;
    }
  }
  return null;
}
