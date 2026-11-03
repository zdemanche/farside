export interface BlobStore {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export class MemoryBlobStore implements BlobStore {
  #objects = new Map<string, string>();

  async put(key: string, body: string): Promise<void> {
    this.#objects.set(key, body);
  }

  async get(key: string): Promise<string | undefined> {
    return this.#objects.get(key);
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.#objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.#objects.delete(key);
      }
    }
  }

  keys(prefix = ""): string[] {
    return [...this.#objects.keys()].filter((key) => key.startsWith(prefix));
  }
}
