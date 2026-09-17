/** Credentials cross only the transport header boundary, never a Mind request. */
export interface SecretReference {
  readonly protocol: "jevyr.secret-reference/1";
  readonly name: string;
  readonly audience: string;
}

export interface SecretBroker {
  authorization(reference: SecretReference, audience: string): string;
}

export function secretReference(name: string, audience: string): SecretReference {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(name)) throw new TypeError("Invalid broker reference name");
  const url = new URL(audience);
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new TypeError("Invalid secret audience");
  return Object.freeze({ protocol: "jevyr.secret-reference/1", name, audience: url.origin });
}

/** Captures only explicitly named credentials. There is no enumerate/export method. */
export class EnvironmentSecretBroker implements SecretBroker {
  readonly #values = new Map<string, { audience: string; value: string }>();
  constructor(references: readonly SecretReference[], environment: NodeJS.ProcessEnv = process.env) {
    for (const reference of references) {
      const canonical = secretReference(reference.name, reference.audience);
      if (reference.protocol !== canonical.protocol || reference.audience !== canonical.audience) throw new TypeError("Invalid secret reference");
      if (this.#values.has(reference.name)) throw new TypeError("Duplicate secret reference");
      const value = environment[reference.name];
      if (!value || value.length > 16_384 || /[\r\n\0]/u.test(value)) throw new Error(`Credential unavailable for broker reference ${reference.name}`);
      this.#values.set(reference.name, { audience: reference.audience, value });
    }
    Object.freeze(this);
  }
  authorization(reference: SecretReference, audience: string): string {
    const entry = this.#values.get(reference.name);
    if (reference.protocol !== "jevyr.secret-reference/1" || !entry || entry.audience !== reference.audience || new URL(audience).origin !== entry.audience) {
      throw new Error("Broker reference is not authorized for this audience");
    }
    return `Bearer ${entry.value}`;
  }
}
