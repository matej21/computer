import { describe, expect, it } from "vitest";

import { NEXTJS_MACRO_OPERATIONS, selectReadableFiles } from "./nextjs-macro.js";

describe("Next.js macro benchmark contract", () => {
  it("keeps the original operation set", () => {
    expect(NEXTJS_MACRO_OPERATIONS).toEqual([
      "git.status (loose)",
      "git.commit",
      "git.add (all)",
      "git.diffSummary",
      "git.status (packed)",
      "fs.readFiles ×50",
      "fs.rmFiles ×50",
      "fs.rm ×50 (loop)",
    ]);
  });

  it("selects readable files in input order", () => {
    const selected = selectReadableFiles(
      [
        { path: "/repo/a", content: new Uint8Array([1]) },
        {
          path: "/repo/missing",
          error: { code: "ENOENT", message: "missing", path: "/repo/missing" },
        },
        { path: "/repo/b", content: new Uint8Array([2, 3]) },
      ],
      2,
    );

    expect(selected).toEqual([
      { path: "/repo/a", content: new Uint8Array([1]) },
      { path: "/repo/b", content: new Uint8Array([2, 3]) },
    ]);
  });

  it("rejects a fixture without enough readable files", () => {
    expect(() =>
      selectReadableFiles(
        [
          {
            path: "/repo/missing",
            error: { code: "ENOENT", message: "missing", path: "/repo/missing" },
          },
        ],
        1,
      ),
    ).toThrow("Next.js fixture has fewer than 1 readable files");
  });
});
