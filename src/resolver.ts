import * as fs from "node:fs";
import * as path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".test", "coverage"]);

function walkDir(dir: string, filter: (name: string) => boolean): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...walkDir(fullPath, filter));
    } else if (entry.isFile() && filter(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

export function findTsFiles(dir: string): string[] {
  return walkDir(dir, (name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"));
}

export function findAllFiles(dir: string): string[] {
  return walkDir(dir, () => true);
}

export function resolveCandidates(base: string): string[] {
  return [base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx")];
}

export function resolveImportTarget(
  importerPath: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;

  const dir = path.dirname(importerPath);
  let resolved = path.resolve(dir, specifier);

  // Strip .js/.jsx extension to find the .ts/.tsx source
  resolved = resolved.replace(/\.jsx?$/, "");

  const candidates = resolveCandidates(resolved);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function computeNewImportPath(
  importerNewPath: string,
  targetNewPath: string,
  usesJsExtension: boolean,
): string {
  let relative = path.relative(
    path.dirname(importerNewPath),
    targetNewPath,
  );

  if (!relative.startsWith(".")) {
    relative = "./" + relative;
  }

  // Remove .ts/.tsx extension
  relative = relative.replace(/\.tsx?$/, "");

  if (usesJsExtension) {
    const ext = targetNewPath.endsWith(".tsx") ? ".jsx" : ".js";
    if (!relative.endsWith(ext)) {
      relative += ext;
    }
  }

  return relative;
}
