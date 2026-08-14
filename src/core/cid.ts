import { CID } from "multiformats/cid";
import * as sha256 from "multiformats/hashes/sha2";
import * as dagJson from "@ipld/dag-json";
import { canonicalBytes } from "./serialize.ts";

export async function computeCid(node: unknown): Promise<string> {
  return await computeCidFromBytes(canonicalBytes(node));
}

export async function computeCidFromBytes(bytes: Uint8Array): Promise<string> {
  const digest = await sha256.sha256.digest(bytes);
  const cid = CID.create(1, dagJson.code, digest);
  return cid.toString();
}

export function cidFromBytes(bytes: Uint8Array): string {
  return CID.decode(bytes).toString();
}

export function normalizeLinks(value: unknown): unknown {
  if (value instanceof CID) {
    return { "/": value.toString() };
  }
  if (value instanceof Uint8Array) {
    try {
      return { "/": CID.decode(value).toString() };
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map(normalizeLinks);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeLinks(v)]),
    );
  }
  return value;
}
