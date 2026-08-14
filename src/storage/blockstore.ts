import { computeCidFromBytes } from "../core/cid.ts";

export interface Blockstore {
  put(bytes: Uint8Array): Promise<string>;
  delete(cid: string): Promise<void>;
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

  private filePath(cid: string): string {
    return `${this.#dir}/${cid}.json`;
  }
}
