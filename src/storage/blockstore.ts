import { computeCidFromBytes } from "../core/cid.ts";

export interface Block {
  cid: string;
  bytes: Uint8Array;
}

export interface Blockstore {
  put(bytes: Uint8Array): Promise<string>;
  delete(cid: string): Promise<void>;
  list(): Promise<Block[]>;
}

export interface FileBlockstoreOptions {
  dir: string;
}

export class FileBlockstore implements Blockstore {
  #dir: string;

  constructor(options: FileBlockstoreOptions) {
    this.#dir = options.dir;
  }

  async put(bytes: Uint8Array): Promise<string> {
    const cid = await computeCidFromBytes(bytes);
    await Deno.mkdir(this.#dir, { recursive: true });
    await Deno.writeFile(this.filePath(cid), bytes);
    return cid;
  }

  async delete(cid: string): Promise<void> {
    try {
      await Deno.remove(this.filePath(cid));
    } catch {
      // file already absent: nothing to clean up
    }
  }

  async list(): Promise<Block[]> {
    const entries = [];
    try {
      for await (const entry of Deno.readDir(this.#dir)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          entries.push(entry.name);
        }
      }
    } catch {
      return [];
    }
    const blocks: Block[] = [];
    for (const name of entries) {
      const cid = name.slice(0, -".json".length);
      try {
        const bytes = await Deno.readFile(this.filePath(cid));
        blocks.push({ cid, bytes });
      } catch {
        // a file that vanished between listing and reading is skipped
      }
    }
    return blocks;
  }

  private filePath(cid: string): string {
    return `${this.#dir}/${cid}.json`;
  }
}
