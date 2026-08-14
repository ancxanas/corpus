import { assertEquals } from "@std/assert";
import { uuidv7 } from "../src/core/uuidv7.ts";
import {
  canonicalString,
  parseCanonicalString,
} from "../src/core/serialize.ts";
import {
  generateKeyPair,
  signMessage,
  signNode,
  verifyMessage,
  verifyNodeSignature,
} from "../src/core/sign.ts";
import { computeCid } from "../src/core/cid.ts";
import type { Node } from "../src/core/types.ts";

const node: Node = {
  osk: {
    version: "0.3.0",
    node_type: "Problem",
    node_id: "0190c0a0-0000-7000-8000-000000000001",
    knowledge_lifecycle: {
      status: "draft",
      last_verified: "2026-08-14T00:00:00Z",
    },
    attribution: {
      author_type: "agent",
      public_key: "deadbeef",
    },
  },
  payload: { problem: { title: "test" } },
};

Deno.test("uuidv7 is valid format", () => {
  const id = uuidv7();
  assertEquals(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(id),
    true,
  );
});

Deno.test("uuidv7 values are unique", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    seen.add(uuidv7());
  }
  assertEquals(seen.size, 1000);
});

Deno.test("serialization is byte-stable", () => {
  const a = canonicalString(node);
  const b = canonicalString(node);
  assertEquals(a, b);
  const parsed = parseCanonicalString(a) as Node;
  assertEquals(parsed.osk.node_type, "Problem");
});

Deno.test("canonical serialization has sorted keys and no whitespace", () => {
  const str = canonicalString(node);
  assertEquals(str.includes(" "), false);
  assertEquals(str.includes("\n"), false);
  const order = [
    "attribution",
    "knowledge_lifecycle",
    "node_id",
    "node_type",
    "version",
  ];
  const start = str.indexOf('"osk":');
  const end = str.indexOf("payload", start);
  const oskSlice = str.slice(start, end);
  const positions = order.map((k) => oskSlice.indexOf(`"${k}"`));
  assertEquals(positions.every((p) => p >= 0), true);
  assertEquals(positions, [...positions].sort((x, y) => x - y));
});

Deno.test("CID is deterministic", async () => {
  const a = await computeCid(node);
  const b = await computeCid(node);
  assertEquals(a, b);
  assertEquals(a.startsWith("baguqeera"), true);
});

Deno.test("CID changes when content changes", async () => {
  const a = await computeCid(node);
  const other: Node = { ...node, payload: { problem: { title: "different" } } };
  const b = await computeCid(other);
  assertEquals(a === b, false);
});

Deno.test("signature round-trip", () => {
  const { publicKeyHex, secretKeyHex } = generateKeyPair();
  const msg = new TextEncoder().encode("hello corpus");
  const sig = signMessage(msg, secretKeyHex);
  assertEquals(verifyMessage(msg, sig, publicKeyHex), true);
  assertEquals(
    verifyMessage(new TextEncoder().encode("tampered"), sig, publicKeyHex),
    false,
  );
});

Deno.test("node signature round-trip and tamper detection", () => {
  const { publicKeyHex, secretKeyHex } = generateKeyPair();
  const keyedNode: Node = {
    ...node,
    osk: {
      ...node.osk,
      attribution: { ...node.osk.attribution, public_key: publicKeyHex },
    },
  };
  const signed = signNode(keyedNode, secretKeyHex);
  assertEquals(verifyNodeSignature(signed), true);
  const tampered: Node = {
    ...signed,
    payload: { problem: { title: "tampered" } },
  };
  assertEquals(verifyNodeSignature(tampered), false);
});

Deno.test("unsigned node fails verification", () => {
  assertEquals(verifyNodeSignature(node), false);
});

Deno.test("signature binds node_id to payload", () => {
  const { publicKeyHex, secretKeyHex } = generateKeyPair();
  const keyedNode: Node = {
    ...node,
    osk: {
      ...node.osk,
      attribution: { ...node.osk.attribution, public_key: publicKeyHex },
    },
  };
  const signed = signNode(keyedNode, secretKeyHex);
  const rebound: Node = {
    ...signed,
    osk: { ...signed.osk, node_id: "0190c0a0-0000-7000-8000-000000000999" },
  };
  assertEquals(verifyNodeSignature(rebound), false);
});
