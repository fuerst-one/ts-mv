import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { executeMoves } from "./mover.js";
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures-paths");
const { setupProject, readFile, fileExists, typecheck, cleanup } = createTestHelpers(TEST_DIR);

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

describe("absolute vs relative path handling", () => {
  it("handles absolute paths in moves map", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./utils";\n',
    });

    // Use absolute paths directly in the moves map
    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        [path.join(TEST_DIR, "src/utils.ts")]: path.join(TEST_DIR, "src/lib/utils.ts"),
      },
    });
    typecheck();

    expect(fileExists("src/lib/utils.ts")).toBe(true);
    expect(fileExists("src/utils.ts")).toBe(false);
    expect(readFile("src/main.ts")).toContain('"./lib/utils"');
  });

  it("handles mixed absolute source and relative dest", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./utils";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        [path.join(TEST_DIR, "src/utils.ts")]: "src/lib/utils.ts",
      },
    });
    typecheck();

    expect(fileExists("src/lib/utils.ts")).toBe(true);
    expect(fileExists("src/utils.ts")).toBe(false);
  });

  it("handles relative paths (resolved against projectRoot)", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./utils";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });
    typecheck();

    expect(fileExists("src/lib/utils.ts")).toBe(true);
    expect(readFile("src/main.ts")).toContain('"./lib/utils"');
  });
});

describe("root directory edge cases", () => {
  it("moves file from project src root to subdirectory", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./utils";\nconsole.log(x);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/deep/nested/utils.ts" },
    });
    typecheck();

    expect(fileExists("src/deep/nested/utils.ts")).toBe(true);
    expect(readFile("src/main.ts")).toContain('"./deep/nested/utils"');
  });

  it("moves file from deep nesting to project src root", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/deep/nested/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./deep/nested/utils";\nconsole.log(x);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/deep/nested/utils.ts": "src/utils.ts" },
    });
    typecheck();

    expect(fileExists("src/utils.ts")).toBe(true);
    expect(fileExists("src/deep/nested/utils.ts")).toBe(false);
    expect(readFile("src/main.ts")).toContain('"./utils"');
    // Empty dirs should be cleaned up
    expect(fileExists("src/deep")).toBe(false);
  });

  it("moves file between sibling directories at different depths", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a/b/c/deep.ts": "export const deep = 1;\n",
      "src/x/shallow.ts": 'import { deep } from "../a/b/c/deep";\nexport const val = deep;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/a/b/c/deep.ts": "src/y/z/deep.ts" },
    });
    typecheck();

    expect(fileExists("src/y/z/deep.ts")).toBe(true);
    expect(readFile("src/x/shallow.ts")).toContain('"../y/z/deep"');
  });
});
