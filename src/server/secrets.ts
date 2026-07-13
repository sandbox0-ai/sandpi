import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export interface EncryptedValue {
  ciphertext: Buffer;
  initializationVector: Buffer;
  authenticationTag: Buffer;
  algorithm: "aes-256-gcm";
  keyId: string;
}

export class SecretBox {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(secret: string, keyId = "deployment-v1") {
    if (
      Buffer.byteLength(secret, "utf8") < 32 ||
      /^replace[-_ ]?with/i.test(secret)
    ) {
      throw new Error(
        "Deployment encryption keys must be at least 32 bytes and cannot be an example placeholder.",
      );
    }
    this.key = createHash("sha256").update(secret, "utf8").digest();
    this.keyId = keyId;
  }

  encrypt(value: string, associatedData?: string): EncryptedValue {
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, initializationVector);
    if (associatedData) cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext,
      initializationVector,
      authenticationTag: cipher.getAuthTag(),
      algorithm: "aes-256-gcm",
      keyId: this.keyId,
    };
  }

  decrypt(value: EncryptedValue, associatedData?: string): string {
    if (value.algorithm !== "aes-256-gcm") {
      throw new Error(`Unsupported secret algorithm: ${value.algorithm}`);
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      value.initializationVector,
    );
    if (associatedData) decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(value.authenticationTag);
    return Buffer.concat([
      decipher.update(value.ciphertext),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function secretHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}
