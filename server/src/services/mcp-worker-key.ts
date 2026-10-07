import { createPublicKey, verify } from "node:crypto";

/** Only canonical Ed25519 SPKI public keys; private keys and aliases are invalid. */
export function requireMcpWorkerKey(encoded: string) {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== 44 || bytes.toString("base64") !== encoded) throw new Error("Invalid worker public key");
  const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid worker public key");
  return key;
}

export function verifyMcpWorkerSignature(proof: Buffer, signature: string, publicKey: string): boolean {
  try {
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
    const bytes = Buffer.from(signature, "base64url");
    return bytes.length === 64 && bytes.toString("base64url") === signature &&
      verify(null, proof, requireMcpWorkerKey(publicKey), bytes);
  } catch { return false; }
}
