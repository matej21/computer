// Tests for `createGitClient` — the workspace-bound entry point.
//
// The wrapping is thin: build an FsClient from `ws.provider()`
// once, hand it to `cloneWith` / `diffWith` on each call. The
// behaviour of those two is covered by clone.test.ts and
// diff.test.ts; what's worth pinning here is the binding contract.

import type { SQLiteWorkspaceProvider } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import { Workspace } from "../workspace.js";
import type { IsomorphicGitFSClient } from "./adapter.js";
import { createGitClient } from "./index.js";

function stubFs(): IsomorphicGitFSClient {
  return {
    promises: {
      readFile: vi.fn(async () => new Uint8Array()),
    },
  };
}

describe("createGitClient", () => {
  it("gives every Git call one operation-bound provider", async () => {
    const storage = new SQLiteTestStorage();
    const ws = new Workspace({ storage });
    const rootProvider = ws.provider();
    const provider = vi.fn(() => rootProvider);
    const fs = stubFs();
    const operationProviders: SQLiteWorkspaceProvider[] = [];
    const stagedDirentCounts: number[] = [];
    const adapter = vi.fn(async (operationProvider: SQLiteWorkspaceProvider) => {
      operationProviders.push(operationProvider);
      const index = operationProviders.length;
      const path = `/operation-${index}.txt`;
      await operationProvider.writeFile(path, `content ${index}`);
      await Promise.resolve();
      expect((await operationProvider.lstat(path)).size).toBe(9);
      stagedDirentCounts.push(
        rootProvider.db.scalar<number>(
          "SELECT COUNT(*) FROM vfs_dirents WHERE parent_inode = 1 AND name = ?",
          `operation-${index}.txt`,
        ) ?? 0,
      );
      return fs;
    });

    const client = createGitClient({ adapter })({ ws: { provider } });

    // No work happens at construction time.
    expect(provider).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();

    try {
      await client.clone({ url: "https://example.test/repo.git" }).catch(() => {});
      expect(provider).toHaveBeenCalledTimes(1);
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(stagedDirentCounts).toEqual([0]);
      expect(operationProviders[0]).not.toBe(rootProvider);
      expect(() => operationProviders[0]?.existsSync("/")).toThrowError(
        "Database operation is closed",
      );

      await client.diff().catch(() => {});
      expect(provider).toHaveBeenCalledTimes(1);
      expect(adapter).toHaveBeenCalledTimes(2);
      expect(stagedDirentCounts).toEqual([0, 0]);
      expect(operationProviders[1]).not.toBe(operationProviders[0]);
      expect(() => operationProviders[1]?.existsSync("/")).toThrowError(
        "Database operation is closed",
      );
    } finally {
      await ws.close();
      storage.close();
    }
  });
});
