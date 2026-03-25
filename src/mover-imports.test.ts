import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { executeMoves } from "./mover.js";
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures-imports");
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

const TSCONFIG_WITH_PATHS = JSON.stringify({
  compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "bundler",
    rootDir: "src", outDir: "dist", jsx: "react-jsx", skipLibCheck: true,
    baseUrl: ".", paths: { "@/*": ["src/*"] },
  },
  include: ["src"],
});

beforeEach(() => { cleanup(); });
afterEach(() => { cleanup(); });

describe("import specifier edge cases", () => {
  it("handles side-effect import", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/polyfill.ts": "// polyfill\nglobalThis.foo = true;\n",
      "src/main.ts": 'import "./polyfill";\nconsole.log("ready");\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/polyfill.ts": "src/setup/polyfill.ts" },
    });
    typecheck();

    expect(fileExists("src/setup/polyfill.ts")).toBe(true);
    expect(readFile("src/main.ts")).toContain('"./setup/polyfill"');
  });

  it("does not rewrite npm package imports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function helper() { return 1; }\n",
      "src/main.ts":
        'import lodash from "lodash";\nimport { helper } from "./utils";\nconsole.log(lodash, helper());\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/main.ts": "src/app/main.ts" },
    });
    // Skip typecheck — lodash types not installed in fixture

    const content = readFile("src/app/main.ts");
    expect(content).toContain('"lodash"');
    expect(content).toContain('"../utils"');
  });

  it("handles type-only imports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/types.ts": "export type Foo = { x: number };\n",
      "src/main.ts":
        'import type { Foo } from "./types";\nconst f: Foo = { x: 1 };\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/types.ts": "src/lib/types.ts" },
    });
    typecheck();

    expect(readFile("src/main.ts")).toContain('"./lib/types"');
  });

  it("handles namespace imports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts":
        "export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\n",
      "src/main.ts":
        'import * as utils from "./utils";\nconsole.log(utils.add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });
    typecheck();

    expect(readFile("src/main.ts")).toContain(
      'import * as utils from "./lib/utils"',
    );
  });
});

describe("star re-exports", () => {
  it("updates export * from declarations when target moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\n",
      "src/index.ts": 'export * from "./utils";\n',
      "src/main.ts": 'import { add } from "./index";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    expect(readFile("src/index.ts")).toContain('export * from "./lib/utils"');
    typecheck();
  });

  it("updates export * from when target moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/math.ts": "export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\n",
      "src/index.ts": 'export * from "./math";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/math.ts": "src/lib/math.ts" },
    });

    const indexContent = readFile("src/index.ts");
    expect(indexContent).toContain('"./lib/math"');
    expect(indexContent).not.toContain('"./math"');
    typecheck();
  });

  it("updates mixed named and star re-exports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\nexport const specific = 42;\n",
      "src/barrel.ts": 'export * from "./utils";\nexport { specific } from "./utils";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    const barrelContent = readFile("src/barrel.ts");
    expect(barrelContent).toContain('"./lib/utils"');
    // Both the star export and named export should be updated
    expect(barrelContent).not.toContain('"./utils"');
    // Count occurrences of ./lib/utils — should be 2 (star + named)
    const matches = barrelContent.match(/\.\/lib\/utils/g);
    expect(matches).toHaveLength(2);
    typecheck();
  });
});

describe("side-effect imports", () => {
  it("updates side-effect import when both the importer and the target are moved", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": 'import "./b";\nexport const a = 1;\n',
      "src/b.ts": 'console.log("side-effect");\nexport {};\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/a.ts": "src/x/a.ts",
        "src/b.ts": "src/y/b.ts",
      },
    });

    const content = readFile("src/x/a.ts");
    expect(content).toContain('import "../y/b"');
  });

  it("updates side-effect import when BOTH importer and target are moved to different dirs", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/setup.ts": `import "./init"; export {};`,
      "src/init.ts": `console.log("init"); export {};`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/setup.ts": "src/bootstrap/setup.ts",
        "src/init.ts": "src/core/init.ts",
      },
    });

    const content = readFile("src/bootstrap/setup.ts");
    expect(content).toContain(`"../core/init"`);
    typecheck();
  });

  it("updates side-effect import when BOTH importer and target move to DIFFERENT directories with colliding relative paths", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": 'import "./b";\nexport const a = 1;\n',
      "src/b.ts": 'console.log("b");\nexport {};\n',
      // Decoy file at the post-move resolution path
      "src/x/b.ts": 'console.log("wrong-b");\nexport {};\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/a.ts": "src/x/a.ts",
        "src/b.ts": "src/y/b.ts",
      },
    });

    const content = readFile("src/x/a.ts");
    // After move, src/x/a.ts with specifier "./b" resolves to decoy src/x/b.ts.
    // fixSideEffectImports should rewrite to "../y/b" to point at the intended target.
    expect(content).toContain('import "../y/b"');
    typecheck();
  });

  it("updates side-effect import when importer moves but target stays", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/app.ts": `import "./polyfill"; export const x = 1;`,
      "src/polyfill.ts": `(globalThis as any).foo = true; export {};`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/app.ts": "src/sub/app.ts",
      },
    });

    const content = readFile("src/sub/app.ts");
    expect(content).toContain(`"../polyfill"`);
    typecheck();
  });
});

describe("files excluded from tsconfig", () => {
  it("throws when moving a .test.ts file excluded from tsconfig", () => {
    const TSCONFIG_EXCLUDE_TESTS = JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler",
        rootDir: "src", outDir: "dist", jsx: "react-jsx", skipLibCheck: true,
      },
      include: ["src"],
      exclude: ["**/*.test.ts"],
    });

    setupProject({
      "tsconfig.json": TSCONFIG_EXCLUDE_TESTS,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils.test.ts": 'import { add } from "./utils";\nconsole.log(add(1, 2));\n',
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: {
          "src/utils.ts": "src/lib/utils.ts",
          "src/utils.test.ts": "src/lib/utils.test.ts",
        },
      }),
    ).toThrow(/not included in tsconfig/);
  });

  it("succeeds moving included files even when excluded importers exist", () => {
    const TSCONFIG_EXCLUDE_TESTS = JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler",
        rootDir: "src", outDir: "dist", jsx: "react-jsx", skipLibCheck: true,
      },
      include: ["src"],
      exclude: ["**/*.test.ts"],
    });

    setupProject({
      "tsconfig.json": TSCONFIG_EXCLUDE_TESTS,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils.test.ts": 'import { add } from "./utils";\nconsole.log(add(1, 2));\n',
      "src/main.ts": 'import { add } from "./utils";\nexport const result = add(1, 2);\n',
    });

    // Moving utils.ts (included) should work — test file won't be rewritten but that's expected
    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    expect(result.filesMoved).toBe(1);
    // main.ts (in tsconfig) should be rewritten
    expect(readFile("src/main.ts")).toContain('"./lib/utils"');
    // utils.test.ts is excluded — its import is NOT rewritten (stale path warning expected)
    expect(readFile("src/utils.test.ts")).toContain('"./utils"');
  });

  it("throws when moving a .spec.ts file excluded from tsconfig", () => {
    const TSCONFIG_EXCLUDE_SPECS = JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler",
        rootDir: "src", outDir: "dist", jsx: "react-jsx", skipLibCheck: true,
      },
      include: ["src"],
      exclude: ["**/*.spec.ts", "**/*.test.ts"],
    });

    setupProject({
      "tsconfig.json": TSCONFIG_EXCLUDE_SPECS,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils.spec.ts": 'import { add } from "./utils";\nconsole.log(add(1, 2));\n',
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/utils.spec.ts": "src/lib/utils.spec.ts" },
      }),
    ).toThrow(/not included in tsconfig/);
  });

  it("stale path warning for excluded test file with .js imports", () => {
    const TSCONFIG_EXCLUDE_TESTS = JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler",
        rootDir: "src", outDir: "dist", jsx: "react-jsx", skipLibCheck: true,
      },
      include: ["src"],
      exclude: ["**/*.test.ts"],
    });

    setupProject({
      "tsconfig.json": TSCONFIG_EXCLUDE_TESTS,
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "src/c.ts": "export const c = 1;\n",
      "src/c.test.ts": 'import { c } from "./c.js";\nconsole.log(c);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/c.ts": "src/lib/c.ts" },
    });

    // Excluded test file's import is NOT rewritten (stale) — this is expected.
    // The user should use a tsconfig that includes test files, or fix manually.
    expect(readFile("src/c.test.ts")).toContain('"./c.js"');
  });
});

describe("alias side-effect imports", () => {
  it("updates alias side-effect import when target file moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/polyfill.ts": 'console.log("polyfill");\nexport {};\n',
      "src/main.ts": 'import "@/polyfill";\nexport const x = 1;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/polyfill.ts": "src/setup/polyfill.ts" },
      useAliases: "preserve",
    });

    const content = readFile("src/main.ts");
    expect(content).toContain('"@/setup/polyfill"');
  });

  it("converts alias side-effect import to relative in never mode", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/polyfill.ts": 'console.log("polyfill");\nexport {};\n',
      "src/main.ts": 'import "@/polyfill";\nexport const x = 1;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/polyfill.ts": "src/setup/polyfill.ts" },
      useAliases: "never",
    });

    const content = readFile("src/main.ts");
    expect(content).toContain('"./setup/polyfill"');
  });

  it("converts relative side-effect import to alias in always mode", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/polyfill.ts": 'console.log("polyfill");\nexport {};\n',
      "src/features/page.ts": 'import "../polyfill";\nexport const x = 1;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/features/page.ts": "src/views/page.ts" },
      useAliases: "always",
    });

    const content = readFile("src/views/page.ts");
    expect(content).toContain('"@/polyfill"');
  });

  it("resolves relative side-effect import from original path when both files move (decoy file)", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": 'import "./b";\nexport const a = 1;\n',
      "src/b.ts": 'console.log("correct-b");\nexport {};\n',
      // Decoy: a file at the post-move resolution path
      "src/x/b.ts": 'console.log("decoy-b");\nexport {};\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/a.ts": "src/x/a.ts",
        "src/b.ts": "src/y/b.ts",
      },
    });

    // fixSideEffectImports resolves "./b" from src/x/ (post-move) and finds the DECOY.
    // It should resolve from src/ (pre-move) and rewrite to "../y/b"
    const content = readFile("src/x/a.ts");
    expect(content).toContain('"../y/b"');
    expect(content).not.toContain('"./b"');
  });

  it("does not rewrite alias side-effect import when target is not in project", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/main.ts": 'import "@/nonexistent";\nexport const x = 1;\n',
      "src/other.ts": "export const y = 2;\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/other.ts": "src/lib/other.ts" },
    });

    const content = readFile("src/main.ts");
    expect(content).toContain('"@/nonexistent"');
  });
});

describe("CSS/JSON/SVG imports in .js-extension projects", () => {
  it("does not append .js to CSS module imports in .js-extension projects", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      // 3 files with .js imports to establish convention (>50% threshold)
      "src/a.ts": `import { b } from "./b.js"; export const a = b;`,
      "src/b.ts": `import { c } from "./c.js"; export const b = c;`,
      "src/c.ts": `import { d } from "./d.js"; export const c = d;`,
      "src/d.ts": `export const d = 1;`,
      "src/Button.tsx": `import "./Button.module.css"; import { util } from "./util.js"; export function Button() { return util(); }`,
      "src/Button.module.css": `.btn { color: red; }`,
      "src/util.ts": `export function util() { return "ok"; }`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/Button.tsx": "src/ui/Button.tsx",
      },
    });

    const content = readFile("src/ui/Button.tsx");
    // The CSS import should NOT have .css.js — it should remain .css
    expect(content).not.toContain(".css.js");
  });

  it("does not append .js to .json imports in .js-extension projects", () => {
    setupProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022", module: "ESNext", moduleResolution: "bundler",
          rootDir: "src", outDir: "dist", resolveJsonModule: true,
          skipLibCheck: true,
        },
        include: ["src"],
      }),
      "src/a.ts": `import { b } from "./b.js"; export const a = b;`,
      "src/b.ts": `import { c } from "./c.js"; export const c = c;`,
      "src/c.ts": `import { d } from "./d.js"; export const d = d;`,
      "src/d.ts": `export const d = 1;`,
      "src/loader.ts": `import config from "./config.json"; export default config;`,
      "src/config.json": `{ "key": "value" }`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/loader.ts": "src/sub/loader.ts",
      },
    });

    const content = readFile("src/sub/loader.ts");
    expect(content).not.toContain(".json.js");
  });

  it("does not append .js to .svg imports in .js-extension projects", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": `import { b } from "./b.js"; export const a = b;`,
      "src/b.ts": `import { c } from "./c.js"; export const c = c;`,
      "src/c.ts": `import { d } from "./d.js"; export const d = d;`,
      "src/d.ts": `export const d = 1;`,
      "src/Icon.tsx": `import "./icon.svg"; export function Icon() { return null; }`,
      "src/icon.svg": `<svg></svg>`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/Icon.tsx": "src/ui/Icon.tsx",
      },
    });

    const content = readFile("src/ui/Icon.tsx");
    expect(content).not.toContain(".svg.js");
  });

  it("does not crash when TS files import CSS modules", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/Button.tsx": 'import "./Button.module.css";\nexport function Button() { return null; }\n',
      "src/Button.module.css": ".root { color: red; }\n",
    });

    // Should not throw
    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/Button.tsx": "src/ui/Button.tsx" },
    });

    expect(fileExists("src/ui/Button.tsx")).toBe(true);
    expect(fileExists("src/Button.tsx")).toBe(false);
    // Skip typecheck — CSS module imports don't typecheck
  });
});

describe("handleAliases never mode", () => {
  it("never mode strips /index from alias-to-relative conversion", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/store/index.ts": "export const store = {};\n",
      "src/main.ts": 'import { store } from "@/store";\nconsole.log(store);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/main.ts": "src/app/main.ts" },
      useAliases: "never",
    });

    const content = readFile("src/app/main.ts");
    // Should be "../store" not "../store/index"
    expect(content).toContain('"../store"');
    expect(content).not.toContain('"../store/index"');
    typecheck();
  });
});

describe("require() calls", () => {
  it("does not crash when files contain require() calls", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/legacy.ts": 'const fs = require("fs");\nexport const x = 1;\n',
      "src/main.ts": 'import { x } from "./legacy";\nexport const val = x;\n',
    });

    expect(() => {
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/legacy.ts": "src/lib/legacy.ts" },
      });
    }).not.toThrow();

    const mainContent = readFile("src/main.ts");
    expect(mainContent).toContain('"./lib/legacy"');
    expect(fileExists("src/lib/legacy.ts")).toBe(true);
    // The require("fs") should be left alone
    const legacyContent = readFile("src/lib/legacy.ts");
    expect(legacyContent).toContain('require("fs")');
    // Skip typecheck — require may not typecheck in ESM mode
  });

  it("rewrites relative require() when target file moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/config.ts": "export const config = { port: 3000 };\n",
      "src/server.ts": 'const { config } = require("./config");\nexport const port = config.port;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/config.ts": "src/lib/config.ts" },
    });

    const serverContent = readFile("src/server.ts");
    expect(serverContent).toContain('require("./lib/config")');
    expect(serverContent).not.toContain('require("./config")');
    // Skip typecheck — require() may not typecheck in ESM mode
  });

  it("rewrites relative require() when the requiring file moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'const { x } = require("./utils");\nexport const val = x;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/main.ts": "src/app/main.ts" },
    });

    const mainContent = readFile("src/app/main.ts");
    expect(mainContent).toContain('require("../utils")');
    expect(mainContent).not.toContain('require("./utils")');
    // Skip typecheck — require() may not typecheck in ESM mode
  });

  it("leaves non-relative require() calls untouched", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/main.ts": 'const path = require("path");\nconst fs = require("node:fs");\nexport const x = 1;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/main.ts": "src/app/main.ts" },
    });

    const content = readFile("src/app/main.ts");
    expect(content).toContain('require("path")');
    expect(content).toContain('require("node:fs")');
    // Skip typecheck — require() may not typecheck in ESM mode
  });

  it("rewrites require() with .js extension in ESM project", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "src/c.ts": "export const c = 1;\n",
      "src/legacy.ts": 'const { c } = require("./c.js");\nexport const val = c;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/c.ts": "src/lib/c.ts" },
    });

    const legacyContent = readFile("src/legacy.ts");
    expect(legacyContent).toContain('require("./lib/c.js")');
    // Skip typecheck — require() may not typecheck in ESM mode
  });

  it("rewrites require() with alias specifier when target moves", () => {
    const TSCONFIG_ALIAS = JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler",
        rootDir: "src", outDir: "dist", jsx: "react-jsx", skipLibCheck: true,
        baseUrl: ".", paths: { "@/*": ["src/*"] },
      },
      include: ["src"],
    });

    setupProject({
      "tsconfig.json": TSCONFIG_ALIAS,
      "src/config.ts": "export const config = { port: 3000 };\n",
      "src/server.ts": 'const { config } = require("@/config");\nexport const port = config.port;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/config.ts": "src/settings/config.ts" },
      useAliases: "preserve",
    });

    const content = readFile("src/server.ts");
    // Alias should be updated to new path
    expect(content).toContain('require("@/settings/config")');
    expect(content).not.toContain('require("@/config")');
  });

  it("rewrites relative require() when BOTH the requiring file and required file move", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/config.ts": "export const config = { port: 3000 };\n",
      "src/server.ts": 'const { config } = require("./config");\nexport const port = config.port;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/config.ts": "src/core/config.ts",
        "src/server.ts": "src/app/server.ts",
      },
    });

    const serverContent = readFile("src/app/server.ts");
    expect(serverContent).toContain('require("../core/config")');
    expect(serverContent).not.toContain('require("./config")');
    // Skip typecheck — require() may not typecheck in ESM mode
  });

  it("rewrites dynamic import() with alias specifier when target moves", () => {
    const TSCONFIG_ALIAS = JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler",
        rootDir: "src", outDir: "dist", jsx: "react-jsx", skipLibCheck: true,
        baseUrl: ".", paths: { "@/*": ["src/*"] },
      },
      include: ["src"],
    });

    setupProject({
      "tsconfig.json": TSCONFIG_ALIAS,
      "src/plugin.ts": "export function activate() { return true; }\n",
      "src/loader.ts": 'export const mod = import("@/plugin");\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/plugin.ts": "src/plugins/plugin.ts" },
      useAliases: "preserve",
    });

    const content = readFile("src/loader.ts");
    expect(content).toContain('import("@/plugins/plugin")');
    expect(content).not.toContain('import("@/plugin")');
  });
});

describe("template literal dynamic imports", () => {
  it("does not crash on template literal dynamic imports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/loader.ts": "const name = \"foo\";\nexport const m = import(`./plugins/${name}`);\n",
      "src/main.ts": 'import { m } from "./loader";\nexport const val = m;\n',
    });

    expect(() => {
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/loader.ts": "src/lib/loader.ts" },
      });
    }).not.toThrow();

    const loaderContent = readFile("src/lib/loader.ts");
    // Template literal import should be left as-is (cannot statically resolve)
    expect(loaderContent).toContain("import(`./plugins/${name}`)");
    // Skip typecheck — template literal import may not typecheck
  });
});

describe("static and dynamic imports to same target", () => {
  it("updates both static and dynamic imports to same target", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./utils";\nexport const dynamic = import("./utils");\nexport const val = x;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    const mainContent = readFile("src/main.ts");
    // Static import should be updated
    expect(mainContent).toContain('from "./lib/utils"');
    // Dynamic import should also be updated
    expect(mainContent).toContain('import("./lib/utils")');
    typecheck();
  });
});

describe("post-move stale path warnings", () => {
  it("warns about vi.mock() with stale path after move", () => {
    const TSCONFIG_EXCLUDE_TESTS = JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler",
        rootDir: "src", outDir: "dist", jsx: "react-jsx", skipLibCheck: true,
      },
      include: ["src"],
      exclude: ["**/*.test.ts"],
    });

    setupProject({
      "tsconfig.json": TSCONFIG_EXCLUDE_TESTS,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils.test.ts": 'import { vi } from "vitest";\nvi.mock("./utils");\nimport { add } from "./utils";\nconsole.log(add(1, 2));\n',
    });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    // The import should be rewritten, but vi.mock("./utils") is a string in a function call — not an import specifier.
    // MoveResult.warnings should flag utils.test.ts as containing a stale path reference.
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes("utils.test.ts"))).toBe(true);
  });

  it("warns about jest.mock() with stale path after move", () => {
    const TSCONFIG_EXCLUDE_TESTS = JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler",
        rootDir: "src", outDir: "dist", jsx: "react-jsx", skipLibCheck: true,
      },
      include: ["src"],
      exclude: ["**/*.test.ts"],
    });

    setupProject({
      "tsconfig.json": TSCONFIG_EXCLUDE_TESTS,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils.test.ts": 'jest.mock("./utils");\nimport { add } from "./utils";\nconsole.log(add(1, 2));\n',
    });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes("utils.test.ts"))).toBe(true);
  });

  it("warns about string literals matching old relative paths in non-import context", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/config.ts": 'export const PLUGIN_PATH = "./plugins/auth";\n',
      "src/plugins/auth.ts": "export function activate() { return true; }\n",
    });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/plugins/auth.ts": "src/modules/auth.ts" },
    });

    // The string "./plugins/auth" in config.ts is a runtime value, not an import.
    // It should NOT be rewritten. But warnings should flag it.
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes("config.ts"))).toBe(true);
  });

  it("does not warn about paths that were successfully rewritten", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/main.ts": 'import { add } from "./utils";\nconsole.log(add(1, 2));\n',
    });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    // main.ts import IS rewritten by ts-morph. No warning should be emitted for it.
    if (result.warnings) {
      expect(result.warnings.some((w) => w.includes("main.ts"))).toBe(false);
    }
  });

  it("does not warn about unrelated string literals", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/other.ts": 'export const msg = "hello world";\n',
    });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    // other.ts has no reference to utils at all. No warning.
    if (result.warnings) {
      expect(result.warnings.some((w) => w.includes("other.ts"))).toBe(false);
    }
  });
});

describe("vi.mock / jest.mock rewriting", () => {
  it("rewrites vi.mock() string argument when target moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils.test.ts": [
        'import { vi } from "vitest";',
        'vi.mock("./utils");',
        'import { add } from "./utils";',
        "export { add };",
      ].join("\n") + "\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    const content = readFile("src/utils.test.ts");
    expect(content).toContain('vi.mock("./lib/utils")');
  });

  it("rewrites jest.mock() string argument when target moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils.test.ts": [
        'jest.mock("./utils");',
        'import { add } from "./utils";',
        "export { add };",
      ].join("\n") + "\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    const content = readFile("src/utils.test.ts");
    expect(content).toContain('jest.mock("./lib/utils")');
  });

  it("rewrites vi.mock() when the test file itself moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/__tests__/utils.test.ts": [
        'import { vi } from "vitest";',
        'vi.mock("../utils");',
        'import { add } from "../utils";',
        "export { add };",
      ].join("\n") + "\n",
    });

    // Flatten the test file to src/ (different depth)
    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/__tests__/utils.test.ts": "src/utils.test.ts" },
    });

    const content = readFile("src/utils.test.ts");
    // After moving from src/__tests__/ to src/, the relative path should be "./utils"
    expect(content).toContain('vi.mock("./utils")');
  });

  it("rewrites vi.doMock() string argument when target moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils.test.ts": [
        'import { vi } from "vitest";',
        'vi.doMock("./utils");',
        'import { add } from "./utils";',
        "export { add };",
      ].join("\n") + "\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    const content = readFile("src/utils.test.ts");
    expect(content).toContain('vi.doMock("./lib/utils")');
  });

  it("rewrites vi.mock() with .js extension in ESM project", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      // 3 files with .js imports to establish convention
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "src/c.ts": "export const c = 1;\n",
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils.test.ts": [
        'import { vi } from "vitest";',
        'vi.mock("./utils.js");',
        'import { add } from "./utils.js";',
        "export { add };",
      ].join("\n") + "\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    const content = readFile("src/utils.test.ts");
    expect(content).toContain('vi.mock("./lib/utils.js")');
  });

  it("rewrites vi.importActual() string argument when target moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils.test.ts": [
        'import { vi } from "vitest";',
        'vi.mock("./utils", async () => {',
        '  const actual = await vi.importActual("./utils");',
        '  return { ...actual, add: vi.fn() };',
        '});',
        'export {};',
      ].join("\n") + "\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    const content = readFile("src/utils.test.ts");
    expect(content).toContain('vi.mock("./lib/utils"');
    expect(content).toContain('vi.importActual("./lib/utils"');
  });
});

describe("test files", () => {
  it("moves .test.ts files and updates their imports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils.test.ts": 'import { add } from "./utils";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    expect(readFile("src/utils.test.ts")).toContain('"./lib/utils"');
    typecheck();
  });

  it("moves a test file and updates its imports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/__tests__/utils.test.ts": 'import { add } from "../utils";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/__tests__/utils.test.ts": "src/utils.test.ts" },
    });

    expect(readFile("src/utils.test.ts")).toContain('"./utils"');
    typecheck();
  });
});
