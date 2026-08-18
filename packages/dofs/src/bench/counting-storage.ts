// Statement/row counter that wraps a real storage backend.
//
// The benchmark harness runs against a genuine Durable Object
// SqlStorage (see vitest.config.bench.ts). Wall-clock alone can't
// prove *why* an operation is slow, so this decorator sits between the
// `Database` wrapper and the real backend and records every
// `sql.exec` call: how many statements ran, split into reads
// (SELECT/WITH) and writes (INSERT/UPDATE/DELETE/REPLACE), plus a
// best-effort tally of rows touched.
//
// Statement counts are deterministic and backend-independent — they
// are the primary signal for the O(depth) resolution fingerprint
// (`resolveInode` = 1 + 2D statements) and for write-amplification
// analysis (added rows per mutation). Row counts are read opportunist-
// ically off the cursor (the DO backend exposes rowsRead/rowsWritten)
// and are reported as a secondary, best-effort figure.
//
// The decorator forwards transactionSync/transaction straight through
// to the real backend, so real SQLite transaction semantics are
// preserved; only `sql.exec` is instrumented.

import type { DurableObjectStorageLike, SQLCursorLike, SQLStorageLike } from "../types.js";

export interface StatementCounts {
  statements: number;
  reads: number;
  writes: number;
  other: number;
  rowsRead: number;
  rowsWritten: number;
}

function readNumber(source: unknown, key: string): number | undefined {
  const value = (source as Record<string, unknown> | null)?.[key];
  return typeof value === "number" ? value : undefined;
}

const DATA_OPERATIONS = new Set(["select", "insert", "update", "delete", "replace"]);

function topLevelOperation(query: string): string | undefined {
  const leading = /^[a-z]+/i.exec(query.trimStart())?.[0].toLowerCase();
  if (leading !== "with") {
    return leading !== undefined && DATA_OPERATIONS.has(leading) ? leading : undefined;
  }
  let depth = 0;
  let quoteEnd: string | undefined;
  let word = "";

  for (let index = 0; index <= query.length; index++) {
    const character = query[index];
    if (quoteEnd !== undefined) {
      if (character === quoteEnd) {
        if (query[index + 1] === quoteEnd) {
          index += 1;
        } else {
          quoteEnd = undefined;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quoteEnd = character;
      continue;
    }
    if (character === "[") {
      quoteEnd = "]";
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && character !== undefined && /[a-z]/i.test(character)) {
      word += character.toLowerCase();
      continue;
    }
    if (word.length > 0) {
      if (DATA_OPERATIONS.has(word)) return word;
      word = "";
    }
  }
  return undefined;
}

export class CountingStorage implements DurableObjectStorageLike {
  readonly queries: string[] = [];
  statements = 0;
  reads = 0;
  writes = 0;
  other = 0;
  rowsRead = 0;
  rowsWritten = 0;

  readonly sql: SQLStorageLike;
  readonly transactionSync?: <T>(closure: () => T) => T;
  readonly transaction?: <T>(closure: () => T | Promise<T>) => T | Promise<T>;

  constructor(inner: DurableObjectStorageLike) {
    this.sql = {
      exec: <Row extends object = Record<string, unknown>>(
        query: string,
        ...bindings: unknown[]
      ): SQLCursorLike<Row> => {
        this.queries.push(query);
        this.statements += 1;
        this.classify(query);
        const cursor = inner.sql.exec<Row>(query, ...bindings);
        // Writes report rowsWritten eagerly after exec on the DO
        // backend; run() never iterates the cursor, so capture it here.
        const written = readNumber(cursor, "rowsWritten");
        if (written !== undefined) {
          this.rowsWritten += written;
        }
        return {
          toArray: (): Row[] => {
            const rows = cursor.toArray();
            // rowsRead is only meaningful once the cursor is drained,
            // which all() does exactly once.
            this.rowsRead += readNumber(cursor, "rowsRead") ?? rows.length;
            return rows;
          },
        };
      },
    };

    if (inner.transactionSync !== undefined) {
      const delegate = inner.transactionSync.bind(inner);
      this.transactionSync = <T>(closure: () => T): T => delegate(closure);
    }
    if (inner.transaction !== undefined) {
      const delegate = inner.transaction.bind(inner);
      this.transaction = <T>(closure: () => T | Promise<T>): T | Promise<T> => delegate(closure);
    }
  }

  private classify(query: string): void {
    const operation = topLevelOperation(query);
    if (operation === "select") {
      this.reads += 1;
    } else if (operation !== undefined) {
      this.writes += 1;
    } else {
      // SAVEPOINT/RELEASE/PRAGMA/DDL etc. Not part of per-op data cost.
      this.other += 1;
    }
  }

  reset(): void {
    this.queries.length = 0;
    this.statements = 0;
    this.reads = 0;
    this.writes = 0;
    this.other = 0;
    this.rowsRead = 0;
    this.rowsWritten = 0;
  }

  snapshot(): StatementCounts {
    return {
      statements: this.statements,
      reads: this.reads,
      writes: this.writes,
      other: this.other,
      rowsRead: this.rowsRead,
      rowsWritten: this.rowsWritten,
    };
  }
}
