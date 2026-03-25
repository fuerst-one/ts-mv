import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { executeMoves } from "./mover.js";
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures");
const { setupProject, readFile, fileExists, typecheck, cleanup } = createTestHelpers(TEST_DIR);

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "bundler",
    rootDir: "src", outDir: "dist",
  },
  include: ["src"],
});

beforeEach(() => { cleanup(); });
afterEach(() => { cleanup(); });

describe("single file move", () => {
  it("moves a file and updates importers (extensionless)", () => {
    setupProject({
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

  it("moves a file and updates importers (.js extensions)", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/main.ts": 'import { add } from "./utils.js";\nconsole.log(add(1, 2));\n',
      "src/other.ts": 'import { add } from "./utils.js";\nexport const x = add(3, 4);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });
    typecheck();

    expect(fileExists("src/lib/utils.ts")).toBe(true);
    expect(fileExists("src/utils.ts")).toBe(false);
    expect(readFile("src/main.ts")).toContain('"./lib/utils.js"');
    expect(readFile("src/other.ts")).toContain('"./lib/utils.js"');
  });
});

describe("directory move", () => {
  it("moves all files in a directory and updates imports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/helpers/math.ts": "export const add = (a: number, b: number) => a + b;\n",
      "src/helpers/string.ts": "export const upper = (s: string) => s.toUpperCase();\n",
      "src/main.ts": 'import { add } from "./helpers/math";\nimport { upper } from "./helpers/string";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/helpers/": "src/lib/" },
    });
    typecheck();

    expect(fileExists("src/lib/math.ts")).toBe(true);
    expect(fileExists("src/lib/string.ts")).toBe(true);
    expect(fileExists("src/helpers/math.ts")).toBe(false);
    expect(readFile("src/main.ts")).toContain('"./lib/math"');
    expect(readFile("src/main.ts")).toContain('"./lib/string"');
  });
});

describe("moved file's own imports are updated", () => {
  it("updates imports inside the moved file", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/config.ts": "export const PORT = 3000;\n",
      "src/server.ts": 'import { PORT } from "./config";\nconsole.log(PORT);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/server.ts": "src/http/server.ts" },
    });
    typecheck();

    expect(readFile("src/http/server.ts")).toContain('"../config"');
  });
});

describe("re-exports are updated", () => {
  it("updates export ... from declarations", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function helper() { return 1; }\n",
      "src/index.ts": 'export { helper } from "./utils";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });
    typecheck();

    expect(readFile("src/index.ts")).toContain('"./lib/utils"');
  });
});

describe("index file imports", () => {
  it("updates imports to directory index files", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/store/index.ts": 'export { readData } from "./core";\n',
      "src/store/core.ts": "export function readData() { return {}; }\n",
      "src/main.ts": 'import { readData } from "./store";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/store/": "src/storage/" },
    });
    typecheck();

    expect(fileExists("src/storage/index.ts")).toBe(true);
    expect(fileExists("src/storage/core.ts")).toBe(true);
    // Internal import within the moved directory should still work
    expect(readFile("src/storage/index.ts")).toContain('"./core"');
    // External importer should point to new directory
    const mainContent = readFile("src/main.ts");
    expect(mainContent.includes('"./storage"') || mainContent.includes('"./storage/index"')).toBe(true);
  });
});

describe("batch moves", () => {
  it("handles multiple moves in one pass", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": 'import { b } from "./b";\nexport const a = b + 1;\n',
      "src/b.ts": 'import { c } from "./c";\nexport const b = c + 1;\n',
      "src/c.ts": "export const c = 1;\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/a.ts": "src/layer1/a.ts",
        "src/b.ts": "src/layer2/b.ts",
        "src/c.ts": "src/layer3/c.ts",
      },
    });
    typecheck();

    expect(readFile("src/layer1/a.ts")).toContain('"../layer2/b"');
    expect(readFile("src/layer2/b.ts")).toContain('"../layer3/c"');
  });
});

describe("dynamic imports", () => {
  it("updates dynamic import() calls", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/plugin.ts": "export function activate() { return true; }\n",
      "src/loader.ts": 'export const mod = await import("./plugin");\nmod.activate();\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/plugin.ts": "src/plugins/plugin.ts" },
    });
    typecheck();

    expect(readFile("src/loader.ts")).toContain('"./plugins/plugin"');
  });
});

describe("dry run", () => {
  it("does not modify files", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./utils";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
      dryRun: true,
    });

    expect(fileExists("src/utils.ts")).toBe(true);
    expect(fileExists("src/lib/utils.ts")).toBe(false);
    expect(readFile("src/main.ts")).toContain('"./utils"');
  });
});

describe("empty directory cleanup", () => {
  it("removes empty source directories after move", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/deep/nested/file.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./deep/nested/file";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/deep/nested/file.ts": "src/flat/file.ts" },
    });
    typecheck();

    expect(fileExists("src/deep/nested")).toBe(false);
    expect(fileExists("src/deep")).toBe(false);
  });
});
