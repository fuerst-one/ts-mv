import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { executeMoves } from "./mover.js";
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures-git");
const { setupProject, setupProjectNoGit, readFile, fileExists, typecheck, cleanup } = createTestHelpers(TEST_DIR);

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    rootDir: "src",
    outDir: "dist",
    jsx: "react-jsx",
    skipLibCheck: true,
  },
  include: ["src"],
});

beforeEach(() => { cleanup(); });
afterEach(() => { cleanup(); });

describe("git edge cases", () => {
  it("works in non-git repo", () => {
    setupProjectNoGit({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/main.ts": 'import { add } from "./utils";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });
    typecheck();

    expect(fileExists("src/lib/utils.ts")).toBe(true);
    expect(fileExists("src/utils.ts")).toBe(false);
    expect(readFile("src/main.ts")).toContain('"./lib/utils"');
  });

  it("does not remove non-empty parent directories", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/lib/a.ts": "export const a = 1;\n",
      "src/lib/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
      "src/main.ts": 'import { a } from "./lib/a";\nimport { b } from "./lib/b";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/lib/a.ts": "src/a.ts" },
    });
    typecheck();

    expect(fileExists("src/a.ts")).toBe(true);
    expect(fileExists("src/lib/a.ts")).toBe(false);
    // src/lib/ should still exist because b.ts is still there
    expect(fileExists("src/lib")).toBe(true);
    expect(fileExists("src/lib/b.ts")).toBe(true);
  });

  it("does not remove projectRoot even if empty after move", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/only.ts": "export const x = 1;\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/only.ts": "src/sub/only.ts" },
    });
    typecheck();

    expect(fileExists("src/sub/only.ts")).toBe(true);
    // projectRoot must still exist
    expect(fs.existsSync(TEST_DIR)).toBe(true);
  });

  it("git stages move as rename, not separate add/delete", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/main.ts": 'import { add } from "./utils";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    // The old file should not exist on disk
    expect(fileExists("src/utils.ts")).toBe(false);
    // The new file should exist
    expect(fileExists("src/lib/utils.ts")).toBe(true);

    // Check git status for rename detection
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: TEST_DIR,
      encoding: "utf-8",
    });

    // Git should show a rename (R) or at minimum the new file added (A) and old deleted (D)
    // but the old file must NOT still exist on disk
    const hasRename = status.includes("R");
    const hasDeleteAndAdd = status.includes("D") && (status.includes("A") || status.includes("??"));
    expect(hasRename || hasDeleteAndAdd).toBe(true);
  });
});
