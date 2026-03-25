import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeMoves } from "./mover.js";
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures-dirs");
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

describe("directory move edge cases", () => {
  it("moves directory with deeply nested subdirectories", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/lib/deep/nested/file.ts":
        "export function deepHelper() { return 42; }\n",
      "src/main.ts":
        'import { deepHelper } from "./lib/deep/nested/file";\nconsole.log(deepHelper());\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/lib/": "src/core/" },
    });
    typecheck();

    expect(fileExists("src/core/deep/nested/file.ts")).toBe(true);
    expect(fileExists("src/lib/deep/nested/file.ts")).toBe(false);
    expect(readFile("src/main.ts")).toContain('"./core/deep/nested/file"');
  });

  it("directory move does not affect files outside moved directory", () => {
    const unrelatedContent =
      'export function unrelated() { return "untouched"; }\n';

    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/old/helper.ts": "export const x = 1;\n",
      "src/other/unrelated.ts": unrelatedContent,
      "src/main.ts": 'import { x } from "./old/helper";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/old/": "src/new/" },
    });
    typecheck();

    expect(readFile("src/other/unrelated.ts")).toBe(unrelatedContent);
  });

  it("moves directory containing only index.ts barrel with re-exports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/store/slice.ts":
        "export const counterSlice = { count: 0 };\n",
      "src/store/selectors.ts":
        "export const selectCount = (s: any) => s.count;\n",
      "src/store/index.ts":
        'export { counterSlice } from "./slice";\nexport { selectCount } from "./selectors";\n',
      "src/app.ts": 'import { counterSlice } from "./store";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/store/": "src/state/" },
    });
    typecheck();

    expect(fileExists("src/state/index.ts")).toBe(true);
    expect(fileExists("src/state/slice.ts")).toBe(true);
    expect(fileExists("src/state/selectors.ts")).toBe(true);
    const appContent = readFile("src/app.ts");
    expect(appContent.includes('"./state"') || appContent.includes('"./state/index"')).toBe(true);
    // Internal imports within barrel should remain relative to siblings
    const indexContent = readFile("src/state/index.ts");
    expect(indexContent).toContain('"./slice"');
    expect(indexContent).toContain('"./selectors"');
  });
});

describe("directory move with non-TS files", () => {
  it("moves all file types when moving a directory, not just .ts/.tsx", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/components/Button.tsx":
        'import "./Button.module.css";\nexport function Button() { return null; }\n',
      "src/components/Button.module.css": ".btn { color: red; }\n",
      "src/components/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
      "src/components/config.json": '{ "theme": "dark" }\n',
      "src/main.ts":
        'import { Button } from "./components/Button";\nconsole.log(Button);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/components/": "src/ui/" },
    });
    typecheck();

    // All files should be moved, not just .ts/.tsx
    expect(fileExists("src/ui/Button.tsx")).toBe(true);
    expect(fileExists("src/ui/Button.module.css")).toBe(true);
    expect(fileExists("src/ui/icon.svg")).toBe(true);
    expect(fileExists("src/ui/config.json")).toBe(true);
    // Originals should be gone
    expect(fileExists("src/components/Button.module.css")).toBe(false);
    expect(fileExists("src/components/icon.svg")).toBe(false);
    expect(fileExists("src/components/config.json")).toBe(false);
    // TS imports still rewritten
    expect(readFile("src/main.ts")).toContain('"./ui/Button"');
  });

  it("moves non-TS files even in nested subdirectories", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/assets/images/logo.png": "fake-png-data",
      "src/assets/fonts/custom.woff2": "fake-font-data",
      "src/assets/index.ts": "export const LOGO_PATH = './images/logo.png';\n",
      "src/main.ts": 'import { LOGO_PATH } from "./assets";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/assets/": "src/static/" },
    });
    typecheck();

    expect(fileExists("src/static/images/logo.png")).toBe(true);
    expect(fileExists("src/static/fonts/custom.woff2")).toBe(true);
    expect(fileExists("src/static/index.ts")).toBe(true);
    expect(fileExists("src/assets")).toBe(false);
  });
});

describe("barrel file re-exports", () => {
  it("barrel file index.ts re-exports still work after moving the barrel directory", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils/index.ts": 'export { add } from "./math";\nexport { upper } from "./string";\n',
      "src/utils/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils/string.ts": "export function upper(s: string) { return s.toUpperCase(); }\n",
      "src/main.ts": 'import { add, upper } from "./utils";\nconsole.log(add(1, 2), upper("hi"));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils/": "src/lib/" },
    });
    typecheck();

    // main.ts should now import from ./lib (ts-morph may produce ./lib or ./lib/index)
    const mainContent = readFile("src/main.ts");
    expect(mainContent.includes('"./lib"') || mainContent.includes('"./lib/index"')).toBe(true);

    // Barrel's internal re-exports should still reference ./math and ./string
    const barrel = readFile("src/lib/index.ts");
    expect(barrel).toContain('"./math"');
    expect(barrel).toContain('"./string"');
  });

  it("barrel file re-exports updated when individual files move out of barrel", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils/index.ts": 'export { add } from "./math";\nexport { upper } from "./string";\n',
      "src/utils/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils/string.ts": "export function upper(s: string) { return s.toUpperCase(); }\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils/math.ts": "src/lib/math.ts" },
    });
    typecheck();

    const barrel = readFile("src/utils/index.ts");
    expect(barrel).toContain('"../lib/math"');
  });
});

describe("mixed directory move with non-TS files", () => {
  it("directory move preserves all file types and updates TS imports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/components/utils.ts": "export function cx(...classes: string[]) { return classes.join(' '); }\n",
      "src/components/Button.tsx": 'import { cx } from "./utils";\nexport function Button() { return <button className={cx("btn")}>Click</button>; }\n',
      "src/components/Button.module.css": ".btn { color: red; }\n",
      "src/components/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>\n',
      "src/components/config.json": "{}\n",
      "src/main.ts": 'import { Button } from "./components/Button";\nconsole.log(Button);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/components/": "src/ui/" },
    });
    typecheck();

    // All files should exist at new location
    expect(fileExists("src/ui/Button.tsx")).toBe(true);
    expect(fileExists("src/ui/utils.ts")).toBe(true);
    expect(fileExists("src/ui/Button.module.css")).toBe(true);
    expect(fileExists("src/ui/icon.svg")).toBe(true);
    expect(fileExists("src/ui/config.json")).toBe(true);

    // None at old location
    expect(fileExists("src/components/Button.tsx")).toBe(false);
    expect(fileExists("src/components/utils.ts")).toBe(false);
    expect(fileExists("src/components/Button.module.css")).toBe(false);
    expect(fileExists("src/components/icon.svg")).toBe(false);
    expect(fileExists("src/components/config.json")).toBe(false);

    // TS imports updated
    expect(readFile("src/main.ts")).toContain('"./ui/Button"');

    // Non-TS file content preserved
    expect(readFile("src/ui/Button.module.css")).toBe(".btn { color: red; }\n");
    expect(readFile("src/ui/icon.svg")).toContain("<svg");
    expect(readFile("src/ui/config.json")).toBe("{}\n");
  });
});

describe("empty directory", () => {
  it("directory move with empty source directory produces zero moves and no crash", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/main.ts": 'export const x = 1;\n',
    });

    // Create empty directory
    fs.mkdirSync(path.join(TEST_DIR, "src", "empty"), { recursive: true });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/empty/": "src/other/" },
    });

    expect(result.filesMoved).toBe(0);
  });
});

describe("directory move with only non-TS files", () => {
  it("directory move with only non-TS files doesn't crash", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/assets/logo.png": "fake-png-content",
      "src/assets/styles.css": "body { margin: 0; }\n",
      "src/main.ts": "console.log('no asset imports');\n",
    });

    expect(() => {
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/assets/": "src/static/" },
      });
    }).not.toThrow();

    expect(fileExists("src/static/logo.png")).toBe(true);
    expect(fileExists("src/static/styles.css")).toBe(true);
    expect(fileExists("src/assets/logo.png")).toBe(false);
    expect(fileExists("src/assets/styles.css")).toBe(false);
    typecheck();
  });
});

describe("deeply nested destination directory creation", () => {
  it("creates deeply nested destination directories automatically", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function deep() { return 'deep'; }\n",
      "src/main.ts": 'import { deep } from "./utils";\nconsole.log(deep());\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/a/b/c/d/e/utils.ts" },
    });
    typecheck();

    expect(fileExists("src/a/b/c/d/e/utils.ts")).toBe(true);
    expect(fileExists("src/utils.ts")).toBe(false);
    expect(readFile("src/main.ts")).toContain('"./a/b/c/d/e/utils"');
  });
});
