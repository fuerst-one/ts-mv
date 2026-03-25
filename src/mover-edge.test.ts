import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { executeMoves } from "./mover.js";
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures-edge");
const { setupProject, setupProjectNoGit, readFile, fileExists, typecheck, cleanup } = createTestHelpers(TEST_DIR);

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "bundler",
    rootDir: "src", outDir: "dist", jsx: "react-jsx", skipLibCheck: true,
  },
  include: ["src"],
});

beforeEach(() => { cleanup(); });
afterEach(() => { cleanup(); });

describe("extension convention edge cases", () => {
  it("detects .js convention even when some files have no relative imports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/helpers.ts": "export function mul(a: number, b: number) { return a * b; }\n",
      "src/constants.ts": "export const PI = 3.14;\n",
      // 3 files with .js relative imports
      "src/a.ts": 'import { add } from "./utils.js";\nexport const a = add(1, 2);\n',
      "src/b.ts": 'import { mul } from "./helpers.js";\nexport const b = mul(3, 4);\n',
      "src/c.ts": 'import { PI } from "./constants.js";\nexport const c = PI;\n',
      // 2 files with only npm imports (no relative imports)
      "src/d.ts": 'export const d = "no-imports";\n',
      "src/e.ts": 'export const e = "also-no-imports";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    const content = readFile("src/a.ts");
    expect(content).toContain("./lib/utils.js");
    typecheck();
  });

  it("defaults to extensionless when project has no relative imports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": 'export const a = "a";\n',
      "src/b.ts": 'export const b = "b";\n',
      "src/c.ts": 'export const c = "c";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/a.ts": "src/lib/a.ts" },
    });

    expect(fileExists("src/lib/a.ts")).toBe(true);
    expect(fileExists("src/a.ts")).toBe(false);
    typecheck();
  });
});

describe("symlinks", () => {
  it("directory move handles symlinks gracefully", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/real.ts": "export const real = 1;\n",
      "src/main.ts": 'import { real } from "./real";\nexport const m = real;\n',
    });

    // Create a symlink src/link.ts -> src/real.ts
    const linkPath = path.join(TEST_DIR, "src", "link.ts");
    const realPath = path.join(TEST_DIR, "src", "real.ts");
    fs.symlinkSync(realPath, linkPath);

    // Stage the symlink in git
    execFileSync("git", ["add", "."], { cwd: TEST_DIR, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "add symlink"], { cwd: TEST_DIR, stdio: "pipe" });

    // Move directory — should not crash
    expect(() => {
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/real.ts": "src/lib/real.ts" },
      });
    }).not.toThrow();

    expect(fileExists("src/lib/real.ts")).toBe(true);
    // Skip typecheck — symlink may cause duplicate declarations
  });
});

describe("non-module and special file types", () => {
  it("moves a non-module .ts file and updates importers", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/globals.ts": "(globalThis as any).myGlobal = true;\n",
      "src/main.ts": 'import "./globals";\nexport const x = 1;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/globals.ts": "src/setup/globals.ts" },
    });

    const mainContent = readFile("src/main.ts");
    expect(mainContent).toContain('"./setup/globals"');
    expect(fileExists("src/setup/globals.ts")).toBe(true);
    expect(fileExists("src/globals.ts")).toBe(false);
    typecheck();
  });

  it("handles empty/whitespace-only TS files without crashing", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/empty.ts": "\n",
      "src/main.ts": "export const x = 1;\n",
    });

    expect(() => {
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/empty.ts": "src/lib/empty.ts" },
      });
    }).not.toThrow();

    expect(fileExists("src/lib/empty.ts")).toBe(true);
    expect(fileExists("src/empty.ts")).toBe(false);
    typecheck();
  });
});

describe("unicode characters in file names", () => {
  it("handles unicode characters in file names", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/\u00FCber-utils.ts": "export const uber = 1;\n",
      "src/main.ts": 'import { uber } from "./\u00FCber-utils";\nexport const val = uber;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/\u00FCber-utils.ts": "src/lib/\u00FCber-utils.ts" },
    });

    const mainContent = readFile("src/main.ts");
    expect(mainContent).toContain("./lib/\u00FCber-utils");
    expect(fileExists("src/lib/\u00FCber-utils.ts")).toBe(true);
    typecheck();
  });
});

describe("line endings", () => {
  it("preserves CRLF line endings in moved files", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\r\nexport function sub(a: number, b: number) { return a - b; }\r\n",
      "src/main.ts": 'import { add } from "./utils";\r\nexport const val = add(1, 2);\r\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    const movedContent = readFile("src/lib/utils.ts");
    // ts-morph may normalize line endings — document the behavior either way
    expect(movedContent).toContain("\r\n");
    typecheck();
  });
});

describe("deeply nested paths", () => {
  it("handles deeply nested paths (10+ levels)", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a/b/c/d/e/f/g/h/i/j/deep.ts": "export const deep = 42;\n",
      "src/main.ts": 'import { deep } from "./a/b/c/d/e/f/g/h/i/j/deep";\nexport const val = deep;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/a/b/c/d/e/f/g/h/i/j/deep.ts": "src/shallow.ts" },
    });

    const mainContent = readFile("src/main.ts");
    expect(mainContent).toContain('"./shallow"');
    expect(mainContent).not.toContain('"./a/b/c/d/e/f/g/h/i/j/deep"');
    expect(fileExists("src/shallow.ts")).toBe(true);
    expect(fileExists("src/a/b/c/d/e/f/g/h/i/j/deep.ts")).toBe(false);

    // Verify empty directories cleaned up
    expect(fileExists("src/a/b/c/d/e/f/g/h/i/j")).toBe(false);

    typecheck();
  });
});

describe("scale edge cases", () => {
  it("handles file with many imports (20+)", () => {
    const files: Record<string, string> = {
      "tsconfig.json": TSCONFIG,
    };

    // Create 20 module files
    for (let i = 1; i <= 20; i++) {
      files[`src/mod${i}.ts`] = `export const val${i} = ${i};\n`;
    }

    // Create main.ts importing all 20
    const imports = Array.from({ length: 20 }, (_, i) =>
      `import { val${i + 1} } from "./mod${i + 1}";`
    ).join("\n");
    const usage = Array.from({ length: 20 }, (_, i) => `val${i + 1}`).join(" + ");
    files["src/main.ts"] = `${imports}\nexport const total = ${usage};\n`;

    setupProject(files);

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/main.ts": "src/app/main.ts" },
    });

    const mainContent = readFile("src/app/main.ts");
    // All 20 imports should be updated to "../modN"
    for (let i = 1; i <= 20; i++) {
      expect(mainContent).toContain(`from "../mod${i}"`);
    }
    typecheck();
  });
});

describe("formatting preservation", () => {
  it("preserves original formatting and comments in moved files", () => {
    const originalContent = `// This is a comment
export function   add(
  a:  number,
  b:  number
) {
  return a  +  b; // inline comment
}
`;

    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": originalContent,
      "src/main.ts": 'import { add } from "./utils";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    // The file has no imports to rewrite, so content should be byte-identical
    expect(readFile("src/lib/utils.ts")).toBe(originalContent);
    typecheck();
  });
});

describe("extension detection sampling", () => {
  it("extension detection samples alphabetically first files", () => {
    const files: Record<string, string> = {
      "tsconfig.json": TSCONFIG,
    };

    // First 30 files (alphabetically: a01-a30) use extensionless imports
    for (let i = 1; i <= 30; i++) {
      const name = `a${String(i).padStart(2, "0")}`;
      const prev = i > 1 ? `a${String(i - 1).padStart(2, "0")}` : null;
      files[`src/${name}.ts`] = prev
        ? `import { x } from "./${prev}";\nexport const x = ${i};\n`
        : `export const x = ${i};\n`;
    }

    // Files 31-35 (alphabetically: b01-b05) use .js imports
    for (let i = 1; i <= 5; i++) {
      const name = `b${String(i).padStart(2, "0")}`;
      const prev = `a${String(30 - 5 + i).padStart(2, "0")}`;
      files[`src/${name}.ts`] = `import { x } from "./${prev}.js";\nexport const y = x + ${i};\n`;
    }

    files["src/target.ts"] = "export const target = 42;\n";
    files["src/consumer.ts"] = 'import { target } from "./target";\nexport const val = target;\n';

    setupProject(files);

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/target.ts": "src/lib/target.ts" },
    });

    // Since first 30 files (sampled) use extensionless, convention should be extensionless
    const consumer = readFile("src/consumer.ts");
    expect(consumer).toContain('"./lib/target"');
    expect(consumer).not.toContain(".js");
  });
});

describe("macOS case-insensitive rename", () => {
  it("handles case-only file rename (MyFile.ts -> myFile.ts)", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/MyUtils.ts": `export function helper() { return 42; }`,
      "src/main.ts": `import { helper } from "./MyUtils"; export const x = helper();`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/MyUtils.ts": "src/myUtils.ts",
      },
    });

    expect(fileExists("src/myUtils.ts")).toBe(true);
    const mainContent = readFile("src/main.ts");
    expect(mainContent).toContain(`"./myUtils"`);
    typecheck();
  });
});

describe("excluded directory scanning", () => {
  it("does not scan node_modules when adding excluded files", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./utils";\nexport const val = x;\n',
    });

    // Create a fake node_modules .ts file that imports ./utils
    const nmDir = path.join(TEST_DIR, "node_modules", "fake-pkg", "src");
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(
      path.join(nmDir, "index.ts"),
      'import { x } from "../../../../src/utils";\nexport const y = x;\n',
    );

    // Move should succeed without touching node_modules
    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    // node_modules file should be untouched
    const nmContent = fs.readFileSync(path.join(nmDir, "index.ts"), "utf-8");
    expect(nmContent).toContain("../../../../src/utils");
    typecheck();
  });

  it("does not scan dist directory when adding excluded files", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./utils";\nexport const val = x;\n',
    });

    // Create a fake dist .ts file
    const distDir = path.join(TEST_DIR, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "utils.ts"),
      'export const x = 1;\n',
    );

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    // dist file should be untouched
    const distContent = fs.readFileSync(path.join(distDir, "utils.ts"), "utf-8");
    expect(distContent).toBe("export const x = 1;\n");
    typecheck();
  });

  it("does not scan .test fixture directories", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./utils";\nexport const val = x;\n',
    });

    // Create a .test directory with a .ts file
    const testFixDir = path.join(TEST_DIR, ".test", "some-fixture", "src");
    fs.mkdirSync(testFixDir, { recursive: true });
    fs.writeFileSync(
      path.join(testFixDir, "file.ts"),
      'import { x } from "./utils";\nexport const y = x;\n',
    );

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    // .test fixture file should be untouched
    const fixtureContent = fs.readFileSync(path.join(testFixDir, "file.ts"), "utf-8");
    expect(fixtureContent).toContain('"./utils"');
    typecheck();
  });
});

describe("directory import extension handling", () => {
  it("does not append .js to directory imports in .js-extension projects", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      // 3 files with .js imports to establish convention
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "src/c.ts": 'import { d } from "./d.js";\nexport const c = d;\n',
      "src/d.ts": "export const d = 1;\n",
      // Directory with index.ts
      "src/atoms/index.ts": "export function Button() { return null; }\n",
      // File that imports the directory (no extension, no /index)
      "src/ui/Foo.ts":
        'import { Button } from "../atoms";\nexport const foo = Button;\n',
    });

    // Move an unrelated file to trigger import rewriting on Foo.ts
    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/d.ts": "src/lib/d.ts" },
    });

    const content = readFile("src/ui/Foo.ts");
    // The directory import must NOT become "../atoms.js"
    expect(content).not.toContain('"../atoms.js"');
    // It should stay as "../atoms" or become "../atoms/index.js"
    expect(
      content.includes('"../atoms"') || content.includes('"../atoms/index.js"'),
    ).toBe(true);
  });

  it("correctly handles directory import alongside regular file imports in .js project", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      // 3 files with .js imports to establish convention
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "src/c.ts": "export const c = 1;\n",
      // Directory with index.ts
      "src/atoms/index.ts": "export function Button() { return null; }\n",
      "src/utils.ts": "export const x = 1;\n",
      // File importing both a directory and a regular file
      "src/main.ts": [
        'import { Button } from "./atoms";',
        'import { x } from "./utils.js";',
        "export const val = { Button, x };",
      ].join("\n") + "\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    const content = readFile("src/main.ts");
    // The directory import "./atoms" must NOT be corrupted to "./atoms.js"
    expect(content).not.toContain('"./atoms.js"');
    // The regular file import SHOULD be updated
    expect(content).toContain('"./lib/utils.js"');
  });

  it("appends .js to explicit ./index import in .js-extension project", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      // 3 files with .js imports to establish convention
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "src/c.ts": 'import { d } from "./d.js";\nexport const c = d;\n',
      "src/d.ts": "export const d = 1;\n",
      // Directory with index.ts (barrel)
      "src/store/index.ts": "export const store = 42;\n",
      // Explicit ./store/index import (NOT a directory import)
      "src/main.ts":
        'import { store } from "./store/index";\nexport const val = store;\n',
    });

    // Move an unrelated file to trigger fixJsExtensions
    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/d.ts": "src/lib/d.ts" },
    });

    const content = readFile("src/main.ts");
    // Explicit /index import should get .js appended
    expect(content).toContain('"./store/index.js"');
  });

  it("appends .js to bare ./index import in .js-extension project", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      // 3 files with .js imports to establish convention
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "src/c.ts": 'import { d } from "./d.js";\nexport const c = d;\n',
      "src/d.ts": "export const d = 1;\n",
      // index.ts at src level
      "src/index.ts": "export const x = 1;\n",
      // File importing ./index explicitly
      "src/utils.ts":
        'import { x } from "./index";\nexport const val = x;\n',
    });

    // Move an unrelated file to trigger fixJsExtensions
    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/d.ts": "src/lib/d.ts" },
    });

    const content = readFile("src/utils.ts");
    // Bare ./index should get .js appended
    expect(content).toContain('"./index.js"');
  });

  it("handles barrel re-export with ./index in .js project", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      // 3 files with .js imports to establish convention
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "src/c.ts": "export const c = 1;\n",
      // store barrel re-exports from ./slice
      "src/store/index.ts":
        'export { slice } from "./slice.js";\n',
      "src/store/slice.ts": "export const slice = 42;\n",
      // main.ts imports via explicit ./store/index
      "src/main.ts":
        'import { slice } from "./store/index";\nexport const val = slice;\n',
    });

    // Move the slice file — this triggers rewriting in store/index.ts
    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/store/slice.ts": "src/store/state.ts" },
    });

    const mainContent = readFile("src/main.ts");
    // main.ts explicit /index import should have .js
    expect(mainContent).toContain('"./store/index.js"');

    const storeIndex = readFile("src/store/index.ts");
    // The re-export should point to the renamed file
    expect(storeIndex).toContain('"./state.js"');
  });
});
