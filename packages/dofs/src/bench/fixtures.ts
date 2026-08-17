import type { SQLiteWorkspaceProvider } from "../provider.js";

export function chainOf(depth: number): { dir: string | null; file: string } {
  const segments = Array.from({ length: depth }, (_, index) => `s${index + 1}`);
  const file = `/${segments.join("/")}`;
  const dir = depth > 1 ? `/${segments.slice(0, -1).join("/")}` : null;
  return { dir, file };
}

export function buildChainFile(
  provider: SQLiteWorkspaceProvider,
  depth: number,
  content = "x",
): string {
  const { dir, file } = chainOf(depth);
  if (dir !== null) {
    provider.mkdirSync(dir, { recursive: true });
  }
  provider.writeFileSync(file, content);
  return file;
}
