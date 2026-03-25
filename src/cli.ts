#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { executeMoves, type AliasMode, type MoveManifest } from "./mover.js";

function printUsage() {
  console.log(`
ts-shove — Move TypeScript files with automatic import rewriting

Usage:
  ts-shove <manifest.json>                    Batch move from manifest file
  ts-shove <source> <destination>             Move a single file
  ts-shove <source/dir/> <dest/dir/>          Move a directory (trailing slash)
  ts-shove --dry-run <manifest.json>          Preview without changes
  ts-shove --dry-run <source> <destination>   Preview single move

Manifest format:
  {
    "projectRoot": "/absolute/path",       (optional — defaults to git root or cwd)
    "moves": {
      "src/old.ts": "src/new.ts",          (file move)
      "src/old-dir/": "src/new-dir/"       (directory move — trailing slash)
    },
    "dryRun": false,                       (optional)
    "useAliases": "preserve"               (optional — always | never | preserve)
  }

Options:
  --dry-run, -n              Show what would change without modifying files
  --root, -r <dir>           Project root (default: git root or cwd)
  --tsconfig, -t <path>      Path to tsconfig.json (default: tsconfig.json in project root)
  --use-aliases, -a <mode>   Alias handling: always, never, preserve (default: preserve)
  --help, -h                 Show this help
`);
}

function findGitRoot(): string | null {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function parseArgs(argv: string[]): MoveManifest {
  const args = argv.slice(2);
  let dryRun = false;
  let root: string | null = null;
  let tsConfigPath: string | undefined;
  let useAliases: AliasMode | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--dry-run" || arg === "-n") {
      dryRun = true;
    } else if ((arg === "--root" || arg === "-r") && i + 1 < args.length) {
      root = path.resolve(args[++i]);
    } else if ((arg === "--tsconfig" || arg === "-t") && i + 1 < args.length) {
      tsConfigPath = args[++i];
    } else if ((arg === "--use-aliases" || arg === "-a") && i + 1 < args.length) {
      const val = args[++i];
      if (val !== "always" && val !== "never" && val !== "preserve") {
        console.error(`Invalid --use-aliases value: ${val}. Expected: always, never, preserve`);
        process.exit(1);
      }
      useAliases = val;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  if (positional.length === 0) {
    printUsage();
    process.exit(1);
  }

  // Single argument: manifest file
  if (positional.length === 1) {
    const manifestPath = path.resolve(positional[0]);
    if (!fs.existsSync(manifestPath)) {
      console.error(`Manifest not found: ${manifestPath}`);
      process.exit(1);
    }

    const manifest: MoveManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    manifest.projectRoot = manifest.projectRoot
      ? path.resolve(manifest.projectRoot)
      : root ?? findGitRoot() ?? process.cwd();
    if (dryRun) manifest.dryRun = true;
    if (useAliases) manifest.useAliases = useAliases;
    if (tsConfigPath) manifest.tsConfigPath = tsConfigPath;
    return manifest;
  }

  // Two arguments: source + destination
  if (positional.length === 2) {
    const projectRoot = root ?? findGitRoot() ?? process.cwd();
    return {
      projectRoot,
      moves: { [positional[0]]: positional[1] },
      dryRun,
      useAliases,
      tsConfigPath,
    };
  }

  console.error("Expected 1 (manifest) or 2 (source destination) arguments");
  process.exit(1);
}

const manifest = parseArgs(process.argv);

try {
  executeMoves(manifest);
} catch (err) {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
}
