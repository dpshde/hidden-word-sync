// A D1 database on bun:sqlite with the real migrations, for tests of the server.
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../migrations/", import.meta.url);
export const MIGRATIONS = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(new URL(f, dir), "utf8"));

export function d1(sqlite: Database): D1Database {
  const statement = (sql: string, args: unknown[]) => ({
    sql,
    args,
    bind: (...next: unknown[]) => statement(sql, next),
    async run() {
      sqlite.query(sql).run(...(args as never[]));
      return { success: true, results: [] };
    },
    async all() {
      return { success: true, results: sqlite.query(sql).all(...(args as never[])) };
    },
    async first() {
      return sqlite.query(sql).get(...(args as never[])) ?? null;
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    async batch(statements: Array<{ sql: string; args: unknown[] }>) {
      return sqlite.transaction(() =>
        statements.map((s) => {
          if (/^\s*select/i.test(s.sql)) return { success: true, results: sqlite.query(s.sql).all(...(s.args as never[])) };
          sqlite.query(s.sql).run(...(s.args as never[]));
          return { success: true, results: [] };
        }),
      )();
    },
  } as unknown as D1Database;
}

