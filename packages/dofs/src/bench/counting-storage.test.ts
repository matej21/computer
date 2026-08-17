import { describe, expect, it } from "vitest";

import { RecordingStorage } from "../testing-recording.js";
import { CountingStorage } from "./counting-storage.js";

describe("CountingStorage", () => {
  it("classifies the top-level operation after common table expressions", () => {
    const counting = new CountingStorage(new RecordingStorage());

    counting.sql.exec("WITH source AS (SELECT 1) SELECT * FROM source");
    counting.sql.exec("WITH source AS (SELECT 1) INSERT INTO target SELECT * FROM source");
    counting.sql.exec("WITH source AS (SELECT 1) UPDATE target SET value = 1");
    counting.sql.exec("WITH source AS (SELECT 1) DELETE FROM target");
    counting.sql.exec("CREATE TABLE target_copy AS SELECT * FROM target");

    expect(counting.snapshot()).toMatchObject({
      statements: 5,
      reads: 1,
      writes: 3,
      other: 1,
    });
  });

  it("ignores nested keywords when classifying a recursive CTE write", () => {
    const counting = new CountingStorage(new RecordingStorage());

    counting.sql.exec(`WITH RECURSIVE subtree(inode) AS (
      SELECT 1
      UNION ALL
      SELECT inode + 1 FROM subtree WHERE inode < 10
    )
    INSERT INTO target SELECT inode FROM subtree`);

    expect(counting.snapshot()).toMatchObject({
      statements: 1,
      reads: 0,
      writes: 1,
      other: 0,
    });
  });
});
