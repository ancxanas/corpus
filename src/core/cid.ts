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
