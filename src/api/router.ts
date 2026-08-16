export type RouteGroups = Record<string, string | undefined>;

export interface RouteEntry<T> {
  method: string;
  pattern: URLPattern;
  gate: "accept" | "none";
  matches?: (groups: RouteGroups) => boolean;
  handler: (
    request: Request,
    groups: RouteGroups,
    ctx: T,
  ) => Response | Promise<Response>;
}

export type MatchResult<T> =
  | { kind: "handler"; entry: RouteEntry<T>; groups: RouteGroups }
  | { kind: "notAllowed"; allow: string }
  | { kind: "notFound" };

export function pattern(pathname: string): URLPattern {
  return new URLPattern({ pathname });
}

export function matchRoute<T>(
  routes: RouteEntry<T>[],
  pathname: string,
  method: string,
): MatchResult<T> {
  const hits: Array<{ entry: RouteEntry<T>; groups: RouteGroups }> = [];
  for (const entry of routes) {
    const m = entry.pattern.exec({ pathname });
    if (m === null) {
      continue;
    }
    const groups = m.pathname.groups as RouteGroups;
    if (entry.matches && !entry.matches(groups)) {
      continue;
    }
    hits.push({ entry, groups });
  }
  if (hits.length === 0) {
    return { kind: "notFound" };
  }
  const exact = hits.find((h) => h.entry.method === method);
  if (exact !== undefined) {
    return { kind: "handler", entry: exact.entry, groups: exact.groups };
  }
  const allow = [...new Set(hits.map((h) => h.entry.method))].sort().join(", ");
  return { kind: "notAllowed", allow };
}
