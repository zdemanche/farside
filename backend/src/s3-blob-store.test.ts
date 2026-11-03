import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { S3BlobStore } from "./s3-blob-store.js";

type Handler = (command: unknown) => unknown;

function storeWith(handler: Handler) {
  const send = vi.fn(async (command: unknown) => handler(command));
  return { store: new S3BlobStore("bucket", { send } as unknown as S3Client), send };
}

const bodyOf = (text: string) => ({ transformToString: async () => text });

describe("S3BlobStore", () => {
  it("puts objects encrypted with SSE-S3 and reads them back", async () => {
    const { store, send } = storeWith((command) =>
      command instanceof GetObjectCommand ? { Body: bodyOf("{}") } : {},
    );
    await store.put("ORG#a/x.json", "{}");
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect((send.mock.calls[0]?.[0] as PutObjectCommand).input).toMatchObject({
      Bucket: "bucket",
      Key: "ORG#a/x.json",
      ServerSideEncryption: "AES256",
    });
    expect(await store.get("ORG#a/x.json")).toBe("{}");
  });

  it("maps a missing key to undefined and rethrows everything else", async () => {
    const missing = storeWith(() => {
      throw Object.assign(new Error("gone"), { name: "NoSuchKey" });
    });
    expect(await missing.store.get("k")).toBeUndefined();
    const denied = storeWith(() => {
      throw Object.assign(new Error("denied"), { name: "AccessDenied" });
    });
    await expect(denied.store.get("k")).rejects.toThrow("denied");
  });

  it("deletes a prefix across list pages in batches of at most 1000", async () => {
    const keys = Array.from({ length: 2_500 }, (_, index) => ({ Key: `ORG#a/${index}.json` }));
    const { store, send } = storeWith((command) => {
      if (command instanceof ListObjectsV2Command) {
        return command.input.ContinuationToken
          ? { Contents: keys.slice(1_500) }
          : { Contents: keys.slice(0, 1_500), NextContinuationToken: "page-2" };
      }
      return {};
    });
    await store.deletePrefix("ORG#a/");
    const deletes = send.mock.calls.map(([command]) => command).filter((command) => command instanceof DeleteObjectsCommand);
    expect(deletes.map((command) => (command as DeleteObjectsCommand).input.Delete?.Objects?.length)).toEqual([1000, 500, 1000]);
    expect(send.mock.calls.filter(([command]) => command instanceof ListObjectsV2Command)).toHaveLength(2);
  });

  it("retries keys S3 reports as failed and throws when they never succeed", async () => {
    let calls = 0;
    const flaky = storeWith((command) => {
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [{ Key: "a" }, { Key: "b" }] };
      }
      calls += 1;
      return calls === 1 ? { Errors: [{ Key: "b", Code: "InternalError" }] } : {};
    });
    await flaky.store.deletePrefix("p");
    const retried = flaky.send.mock.calls.map(([command]) => command).filter((command) => command instanceof DeleteObjectsCommand);
    expect((retried[1] as DeleteObjectsCommand).input.Delete?.Objects).toEqual([{ Key: "b" }]);

    const stuck = storeWith((command) =>
      command instanceof ListObjectsV2Command ? { Contents: [{ Key: "a" }] } : { Errors: [{ Key: "a", Code: "AccessDenied" }] },
    );
    await expect(stuck.store.deletePrefix("p")).rejects.toThrow("could not delete 1 objects");
  }, 20_000);
});
