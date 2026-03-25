import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { findTsFiles, resolveImportTarget, computeNewImportPath, findAllFiles } from "./resolver.js";
import { executeMoves } from "./mover.js";
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures-resolver");
const { setupProject, readFile, typecheck, cleanup } = createTestHelpers(TEST_DIR);

function createFile(relativePath: string, content = "") {
  const abs = path.join(TEST_DIR, relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  cleanup();
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => { cleanup(); });

describe("findTsFiles", () => {
  it("finds .ts and .tsx files recursively", () => {
    createFile("a.ts", "export const a = 1;");
    createFile("b.tsx", "export const b = 2;");
    createFile("c.js", "export const c = 3;");
    createFile("d.css", "body {}");
    createFile("sub/e.ts", "export const e = 5;");

    const files = findTsFiles(TEST_DIR);

    const basenames = files.map((f) => path.relative(TEST_DIR, f)).sort();
    expect(basenames).toHaveLength(3);
    expect(basenames).toContain("a.ts");
    expect(basenames).toContain("b.tsx");
    expect(basenames).toContain(path.join("sub", "e.ts"));
    // .js and .css should not be included
    expect(basenames).not.toContain("c.js");
    expect(basenames).not.toContain("d.css");
  });

  it("excludes .d.ts declaration files", () => {
    createFile("types.d.ts", "declare module 'foo';");
    createFile("real.ts", "export const x = 1;");

    const files = findTsFiles(TEST_DIR);

    const basenames = files.map((f) => path.basename(f));
    expect(basenames).toEqual(["real.ts"]);
  });

  it("returns empty array for nonexistent directory", () => {
    const result = findTsFiles(path.join(TEST_DIR, "does-not-exist"));
    expect(result).toEqual([]);
  });

  it("returns empty array for empty directory", () => {
    // TEST_DIR is already created and empty by beforeEach
    const result = findTsFiles(TEST_DIR);
    expect(result).toEqual([]);
  });

  it("handles nested directories with no ts files", () => {
    createFile("a/b/c/styles.css", "body {}");
    createFile("a/b/c/other.css", "div {}");

    const result = findTsFiles(TEST_DIR);
    expect(result).toEqual([]);
  });
});

describe("resolveImportTarget", () => {
  it("resolves extensionless import to .ts file", () => {
    createFile("utils.ts", "export const x = 1;");

    const result = resolveImportTarget(
      path.join(TEST_DIR, "main.ts"),
      "./utils",
    );

    expect(result).toBe(path.join(TEST_DIR, "utils.ts"));
  });

  it("resolves extensionless import to .tsx file", () => {
    createFile("Button.tsx", "export default function Button() {}");

    const result = resolveImportTarget(
      path.join(TEST_DIR, "main.ts"),
      "./Button",
    );

    expect(result).toBe(path.join(TEST_DIR, "Button.tsx"));
  });

  it("resolves .js import to .ts file", () => {
    createFile("utils.ts", "export const x = 1;");

    const result = resolveImportTarget(
      path.join(TEST_DIR, "main.ts"),
      "./utils.js",
    );

    expect(result).toBe(path.join(TEST_DIR, "utils.ts"));
  });

  it("resolves .jsx import to .tsx file", () => {
    createFile("Button.tsx", "export default function Button() {}");

    const result = resolveImportTarget(
      path.join(TEST_DIR, "main.ts"),
      "./Button.jsx",
    );

    expect(result).toBe(path.join(TEST_DIR, "Button.tsx"));
  });

  it("resolves directory import to index.ts", () => {
    createFile("store/index.ts", "export const store = {};");

    const result = resolveImportTarget(
      path.join(TEST_DIR, "main.ts"),
      "./store",
    );

    expect(result).toBe(path.join(TEST_DIR, "store", "index.ts"));
  });

  it("resolves directory import to index.tsx", () => {
    createFile("components/index.tsx", "export default function App() {}");

    const result = resolveImportTarget(
      path.join(TEST_DIR, "main.ts"),
      "./components",
    );

    expect(result).toBe(path.join(TEST_DIR, "components", "index.tsx"));
  });

  it("returns null for non-relative import", () => {
    const result = resolveImportTarget(
      path.join(TEST_DIR, "main.ts"),
      "express",
    );

    expect(result).toBeNull();
  });

  it("returns null for unresolvable import", () => {
    const result = resolveImportTarget(
      path.join(TEST_DIR, "main.ts"),
      "./nonexistent",
    );

    expect(result).toBeNull();
  });
});

describe("computeNewImportPath", () => {
  it("computes same-directory path with ./ prefix", () => {
    const result = computeNewImportPath(
      "/project/src/main.ts",
      "/project/src/utils.ts",
      false,
    );

    expect(result).toMatch(/^\.\//);
    expect(result).toBe("./utils");
  });

  it("computes parent-directory path with ../", () => {
    const result = computeNewImportPath(
      "/project/src/sub/main.ts",
      "/project/src/utils.ts",
      false,
    );

    expect(result).toMatch(/^\.\.\//);
    expect(result).toBe("../utils");
  });

  it("strips .ts extension", () => {
    const result = computeNewImportPath(
      "/project/src/main.ts",
      "/project/src/utils.ts",
      false,
    );

    expect(result).not.toMatch(/\.ts$/);
    expect(result).not.toContain(".ts");
  });

  it("strips .tsx extension", () => {
    const result = computeNewImportPath(
      "/project/src/main.ts",
      "/project/src/Button.tsx",
      false,
    );

    expect(result).not.toMatch(/\.tsx$/);
    expect(result).not.toContain(".tsx");
  });

  it("appends .js when usesJsExtension is true", () => {
    const result = computeNewImportPath(
      "/project/src/main.ts",
      "/project/src/utils.ts",
      true,
    );

    expect(result).toMatch(/\.js$/);
  });

  it("does not append .js when usesJsExtension is false", () => {
    const result = computeNewImportPath(
      "/project/src/main.ts",
      "/project/src/utils.ts",
      false,
    );

    expect(result).not.toMatch(/\.js$/);
  });

  it("handles deeply nested relative paths", () => {
    const result = computeNewImportPath(
      "/project/src/a/b/c/file.ts",
      "/project/src/x/y/z/target.ts",
      false,
    );

    expect(result).toBe("../../../x/y/z/target");
  });
});

describe("module exports", () => {
  it("findTsFiles is exported and functional", () => {
    // Verify findTsFiles is importable and callable — documents it as a public export
    expect(typeof findTsFiles).toBe("function");
    const result = findTsFiles(path.join(TEST_DIR, "does-not-exist"));
    expect(result).toEqual([]);
  });

  it("computeNewImportPath is exported and functional", () => {
    // Verify computeNewImportPath is importable and callable — documents it as a public export
    expect(typeof computeNewImportPath).toBe("function");
    const result = computeNewImportPath("/a/b.ts", "/a/c.ts", false);
    expect(result).toBe("./c");
  });

  it("resolveImportTarget is exported and functional", () => {
    // Verify resolveImportTarget is importable and callable — documents it as a public export
    expect(typeof resolveImportTarget).toBe("function");
    const result = resolveImportTarget("/a/main.ts", "express");
    expect(result).toBeNull();
  });

  it("findAllFiles is exported and functional", () => {
    // Verify findAllFiles is importable and callable — documents it as a public export
    expect(typeof findAllFiles).toBe("function");
    const result = findAllFiles(path.join(TEST_DIR, "does-not-exist"));
    expect(result).toEqual([]);
  });
});

describe("extension convention detection (indirect via executeMoves)", () => {
  const tsconfig = JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      rootDir: "src",
      outDir: "dist",
    },
    include: ["src"],
  });

  it("detects extensionless convention and does not add .js", () => {
    setupProject({
      "tsconfig.json": tsconfig,
      "src/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c";\nexport const b = c;\n',
      "src/c.ts": 'import { d } from "./d";\nexport const c = d;\n',
      "src/d.ts": 'import { e } from "./e";\nexport const d = e;\n',
      "src/e.ts": "export const e = 1;\n",
      "src/target.ts": "export const target = 42;\n",
      "src/consumer.ts": 'import { target } from "./target";\nexport const val = target;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/target.ts": "src/lib/target.ts" },
    });
    typecheck();

    const consumer = readFile("src/consumer.ts");
    expect(consumer).toContain('"./lib/target"');
    expect(consumer).not.toContain(".js");
  });

  it("detects .js convention and adds .js to all rewritten imports", () => {
    setupProject({
      "tsconfig.json": tsconfig,
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "src/c.ts": 'import { d } from "./d.js";\nexport const c = d;\n',
      "src/d.ts": 'import { e } from "./e.js";\nexport const d = e;\n',
      "src/e.ts": "export const e = 1;\n",
      "src/target.ts": 'import { e } from "./e.js";\nexport const target = e;\n',
      "src/consumer.ts": 'import { target } from "./target.js";\nexport const val = target;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/target.ts": "src/lib/target.ts" },
    });
    typecheck();

    // External importer should have .js
    const consumer = readFile("src/consumer.ts");
    expect(consumer).toContain("./lib/target.js");

    // The moved file's own imports should also have .js
    const target = readFile("src/lib/target.ts");
    expect(target).toContain(".js");
  });

  it("mixed convention: majority extensionless means no .js", () => {
    setupProject({
      "tsconfig.json": tsconfig,
      "src/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c";\nexport const b = c;\n',
      "src/c.ts": 'import { d } from "./d";\nexport const c = d;\n',
      "src/d.ts": 'import { e } from "./e";\nexport const d = e;\n',
      // Only one file uses .js extension
      "src/e.ts": 'import { target } from "./target.js";\nexport const e = target;\n',
      "src/target.ts": "export const target = 42;\n",
      "src/consumer.ts": 'import { target } from "./target";\nexport const val = target;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/target.ts": "src/lib/target.ts" },
    });
    typecheck();

    const consumer = readFile("src/consumer.ts");
    expect(consumer).toContain('"./lib/target"');
    expect(consumer).not.toContain(".js");
  });
});
