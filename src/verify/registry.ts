export interface EnvSpec {
  environment_hash: string;
  playground: string;
  platform: string;
  version: string;
  config_hash: string;
}

export class PlaygroundRegistry {
  #envs = new Map<string, EnvSpec>();

  constructor(specs: EnvSpec[] = []) {
    for (const spec of specs) {
      this.register(spec);
    }
  }

  register(spec: EnvSpec): void {
    this.#envs.set(spec.environment_hash, spec);
  }

  lookup(environmentHash: string): EnvSpec | null {
    return this.#envs.get(environmentHash) ?? null;
  }

  get size(): number {
    return this.#envs.size;
  }
}
