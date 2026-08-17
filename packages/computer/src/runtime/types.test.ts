import { expect, it } from "vitest";

import type { WorkspaceClient } from "../client.js";
import type { CreateAIToolsOptions } from "../tools/ai.js";
import type { FindWorkspaceLike } from "../tools/fs/find.js";
import type { WorkspaceRuntimeFilesystem } from "./types.js";

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;

it("includes symlinks in runtime filesystem find results", () => {
  type RuntimeFoundEntry = Awaited<ReturnType<WorkspaceRuntimeFilesystem["find"]>>[number];
  const entryType: RuntimeFoundEntry["type"] = "symlink";

  expect(entryType).toBe("symlink");
});

it("keeps WorkspaceClient assignable to AI tool workspace boundaries", () => {
  const createAIToolsBoundary: IsAssignable<WorkspaceClient, CreateAIToolsOptions["workspace"]> =
    true;
  const findToolBoundary: IsAssignable<WorkspaceClient, FindWorkspaceLike> = true;

  expect(createAIToolsBoundary).toBe(true);
  expect(findToolBoundary).toBe(true);
});
