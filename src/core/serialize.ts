import * as dagJson from "@ipld/dag-json";

export function canonicalBytes(obj: unknown): Uint8Array {
  return dagJson.encode(obj as never);
}

export function canonicalString(obj: unknown): string {
  return new TextDecoder().decode(canonicalBytes(obj));
}

export function parseCanonical(bytes: Uint8Array): unknown {
  return dagJson.decode(bytes);
}

export function parseCanonicalString(str: string): unknown {
  return parseCanonical(new TextEncoder().encode(str));
}
