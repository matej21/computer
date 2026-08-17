import { expect, it } from "vitest";

import type { WorkspaceRuntimeFilesystem } from "./types.js";

it("includes symlinks in runtime filesystem find results", () => {
  type RuntimeFoundEntry = Awaited<ReturnType<WorkspaceRuntimeFilesystem["find"]>>[number];
  const entryType: RuntimeFoundEntry["type"] = "symlink";

  expect(entryType).toBe("symlink");
});
