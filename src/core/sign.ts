import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { Buffer } from "node:buffer";
import type { Node, Osk } from "./types.ts";
import { canonicalBytes } from "./serialize.ts";

const PKCS8_PREFIX = new Uint8Array([
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
]);

const SPKI_PREFIX = new Uint8Array([
  0x30,
  0x2a,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x03,
  0x21,
  0x00,
]);

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  const der = new Uint8Array(PKCS8_PREFIX.length + seed.length);
  der.set(PKCS8_PREFIX);
  der.set(seed, PKCS8_PREFIX.length);
  return createPrivateKey({
    key: Buffer.from(der),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  const der = new Uint8Array(SPKI_PREFIX.length + raw.length);
  der.set(SPKI_PREFIX);
  der.set(raw, SPKI_PREFIX.length);
  return createPublicKey({
    key: Buffer.from(der),
    format: "der",
    type: "spki",
  });
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("hex string must have an even number of hex digits");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function generateKeyPair(): {
  publicKeyHex: string;
  secretKeyHex: string;
} {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = createPublicKey(privateKeyFromSeed(secret));
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = new Uint8Array(
    spki.buffer,
    spki.byteOffset + SPKI_PREFIX.length,
    32,
  );
  return {
    publicKeyHex: bytesToHex(raw),
    secretKeyHex: bytesToHex(secret),
  };
}

export function signMessage(message: Uint8Array, secretKeyHex: string): string {
  const sig = sign(null, message, privateKeyFromSeed(hexToBytes(secretKeyHex)));
  return bytesToHex(new Uint8Array(sig));
}

export function verifyMessage(
  message: Uint8Array,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    return verify(
      null,
      message,
      publicKeyFromRaw(hexToBytes(publicKeyHex)),
      hexToBytes(signatureHex),
    );
  } catch {
    return false;
  }
}

function unsignedObject(node: Node): { osk: Osk; payload: unknown } {
  const { signature: _signature, ...attribution } = node.osk.attribution;
  return { osk: { ...node.osk, attribution }, payload: node.payload };
}

export function signNode(node: Node, secretKeyHex: string): Node {
  const unsigned = unsignedObject(node);
  const signature = signMessage(canonicalBytes(unsigned), secretKeyHex);
  return {
    ...node,
    osk: {
      ...node.osk,
      attribution: { ...node.osk.attribution, signature },
    },
  };
}

export function verifyNodeSignature(node: Node): boolean {
  const signature = node.osk.attribution.signature;
  if (!signature) {
    return false;
  }
  const unsigned = unsignedObject(node);
  return verifyMessage(
    canonicalBytes(unsigned),
    signature,
    node.osk.attribution.public_key,
  );
}
