import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { executeMoves } from "./mover.js";
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures-aliases");
const { setupProject, readFile, fileExists, typecheck, cleanup } = createTestHelpers(TEST_DIR);

const TSCONFIG_WITH_PATHS = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    rootDir: "src",
    outDir: "dist",
    jsx: "react-jsx",
    skipLibCheck: true,
    baseUrl: ".",
    paths: {
      "@/*": ["src/*"],
    },
  },
  include: ["src"],
});

const TSCONFIG_MULTI_ALIAS = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    rootDir: "src",
    outDir: "dist",
    jsx: "react-jsx",
    skipLibCheck: true,
    baseUrl: ".",
    paths: {
      "@/*": ["src/*"],
      "~components/*": ["src/components/*"],
    },
  },
  include: ["src"],
});

beforeEach(() => { cleanup(); });
afterEach(() => { cleanup(); });

describe("useAliases: 'preserve' (default)", () => {
  it("keeps alias imports as aliases after moving the importing file", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/features/page.ts":
        'import { add } from "@/utils/math";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/features/page.ts": "src/views/page.ts" },
      useAliases: "preserve",
    });
    typecheck();

    const content = readFile("src/views/page.ts");
    // Alias import should remain as alias — target didn't move
    expect(content).toContain('@/utils/math');
  });

  it("updates alias imports when target file moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/main.ts":
        'import { add } from "@/utils/math";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils/math.ts": "src/lib/math.ts" },
      useAliases: "preserve",
    });
    typecheck();

    const content = readFile("src/main.ts");
    // Alias should be updated to new alias path
    expect(content).toContain('@/lib/math');
    expect(content).not.toContain("@/utils/math");
  });

  it("keeps relative imports as relative", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/features/page.ts":
        'import { add } from "../utils/math";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/features/page.ts": "src/views/page.ts" },
      useAliases: "preserve",
    });
    typecheck();

    const content = readFile("src/views/page.ts");
    // Should remain relative, not converted to alias
    expect(content).toContain('"../utils/math"');
    expect(content).not.toContain("@/");
  });

  it("updates both alias and relative imports in the same file", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils/string.ts":
        "export function upper(s: string) { return s.toUpperCase(); }\n",
      "src/features/page.ts":
        'import { add } from "@/utils/math";\nimport { upper } from "../utils/string";\nconsole.log(add(1, 2), upper("hi"));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/features/page.ts": "src/views/page.ts" },
      useAliases: "preserve",
    });
    typecheck();

    const content = readFile("src/views/page.ts");
    // Alias stays as alias
    expect(content).toContain('@/utils/math');
    // Relative stays as relative (but updated path)
    expect(content).toContain('"../utils/string"');
    expect(content).not.toContain("@/utils/string");
  });
});

describe("useAliases: 'always'", () => {
  it("converts relative imports to aliases in moved files", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/features/page.ts":
        'import { add } from "../utils/math";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/features/page.ts": "src/views/page.ts" },
      useAliases: "always",
    });
    typecheck();

    const content = readFile("src/views/page.ts");
    // Relative import should be converted to alias
    expect(content).toContain('@/utils/math');
    expect(content).not.toContain('"../utils/math"');
  });

  it("converts relative imports to aliases in importers of moved files", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/main.ts":
        'import { add } from "./utils/math";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils/math.ts": "src/lib/math.ts" },
      useAliases: "always",
    });
    typecheck();

    const content = readFile("src/main.ts");
    // Importer should use alias for the new path
    expect(content).toContain('@/lib/math');
    expect(content).not.toContain('"./lib/math"');
  });

  it("does not convert imports in files not involved in the move", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/utils/string.ts":
        "export function upper(s: string) { return s.toUpperCase(); }\n",
      "src/features/page.ts":
        'import { add } from "../utils/math";\nconsole.log(add(1, 2));\n',
      // This file is NOT involved in the move at all
      "src/other/unrelated.ts":
        'import { upper } from "../utils/string";\nconsole.log(upper("hi"));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/features/page.ts": "src/views/page.ts" },
      useAliases: "always",
    });
    typecheck();

    // Unrelated file should NOT have its imports converted
    const unrelated = readFile("src/other/unrelated.ts");
    expect(unrelated).toContain('"../utils/string"');
    expect(unrelated).not.toContain("@/");
  });

  it("keeps existing alias imports as aliases", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/features/page.ts":
        'import { add } from "@/utils/math";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/features/page.ts": "src/views/page.ts" },
      useAliases: "always",
    });
    typecheck();

    const content = readFile("src/views/page.ts");
    expect(content).toContain('@/utils/math');
  });

  it("handles .js extension convention with aliases", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/a.ts": 'import { b } from "@/b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "@/c.js";\nexport const b = c;\n',
      "src/c.ts": "export const c = 1;\n",
      "src/main.ts": 'import { a } from "./a.js";\nconsole.log(a);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/b.ts": "src/lib/b.ts" },
      useAliases: "always",
    });
    typecheck();

    const aContent = readFile("src/a.ts");
    // Should have alias with .js extension
    expect(aContent).toContain("@/lib/b.js");
  });
});

describe("useAliases: 'never'", () => {
  it("converts alias imports to relative paths in moved files", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/features/page.ts":
        'import { add } from "@/utils/math";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/features/page.ts": "src/views/page.ts" },
      useAliases: "never",
    });
    typecheck();

    const content = readFile("src/views/page.ts");
    // Alias should be converted to relative
    expect(content).not.toContain("@/");
    expect(content).toContain('"../utils/math"');
  });

  it("converts alias imports to relative in importers of moved files", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/main.ts":
        'import { add } from "@/utils/math";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils/math.ts": "src/lib/math.ts" },
      useAliases: "never",
    });
    typecheck();

    const content = readFile("src/main.ts");
    expect(content).not.toContain("@/");
    expect(content).toContain('"./lib/math"');
  });

  it("does not touch files not involved in the move", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/other/helper.ts":
        'import { add } from "@/utils/math";\nexport const val = add(1, 2);\n',
      "src/main.ts":
        'import { add } from "@/utils/math";\nconsole.log(add(1, 2));\n',
    });

    // Move a file that other/helper.ts does NOT import
    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/main.ts": "src/app/main.ts" },
      useAliases: "never",
    });
    typecheck();

    // Unrelated file should keep its alias
    const helper = readFile("src/other/helper.ts");
    expect(helper).toContain("@/utils/math");
  });

  it("keeps relative imports as relative", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/features/page.ts":
        'import { add } from "../utils/math";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/features/page.ts": "src/views/page.ts" },
      useAliases: "never",
    });
    typecheck();

    const content = readFile("src/views/page.ts");
    expect(content).toContain('"../utils/math"');
    expect(content).not.toContain("@/");
  });
});

describe("useAliases with multiple alias patterns", () => {
  it("uses the most specific alias pattern in 'always' mode", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_MULTI_ALIAS,
      "src/components/Button.tsx":
        "export function Button() { return null; }\n",
      "src/features/page.ts":
        'import { Button } from "../components/Button";\nexport function Page() { return Button(); }\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/features/page.ts": "src/views/page.ts" },
      useAliases: "always",
    });
    typecheck();

    const content = readFile("src/views/page.ts");
    // Should prefer the more specific ~components/* alias over @/*
    expect(content).toContain("~components/Button");
  });

  it("updates alias when target moves in 'preserve' mode with multiple aliases", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_MULTI_ALIAS,
      "src/components/Button.tsx":
        "export function Button() { return null; }\n",
      "src/main.ts":
        'import { Button } from "~components/Button";\nexport function App() { return Button(); }\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/components/Button.tsx": "src/ui/Button.tsx" },
      useAliases: "preserve",
    });
    typecheck();

    const content = readFile("src/main.ts");
    // ~components/Button is no longer valid since file moved outside src/components/
    // Should fall back to @/ui/Button or use relative path
    expect(content).not.toContain("~components/Button");
    const hasAlias = content.includes("@/ui/Button");
    const hasRelative = content.includes("./ui/Button");
    expect(hasAlias || hasRelative).toBe(true);
  });

  it("uses most specific alias when multiple patterns match", () => {
    const tsconfigWithAliases = JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler",
        rootDir: "src", outDir: "dist", skipLibCheck: true,
        baseUrl: ".",
        paths: {
          "@/*": ["src/*"],
          "@utils/*": ["src/utils/*"],
        },
      },
      include: ["src"],
    });

    setupProject({
      "tsconfig.json": tsconfigWithAliases,
      "src/utils/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/main.ts": 'import { add } from "@utils/math";\nexport const result = add(1, 2);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils/math.ts": "src/lib/math.ts" },
      useAliases: "preserve",
    });

    const mainContent = readFile("src/main.ts");
    // @utils/math no longer resolves (file moved outside src/utils/),
    // should fall back to @/lib/math or a relative path
    expect(mainContent).not.toContain("@utils/math");
    expect(
      mainContent.includes("@/lib/math") || mainContent.includes("./lib/math"),
    ).toBe(true);
    typecheck();
  });
});

describe("useAliases defaults to 'preserve'", () => {
  it("defaults to preserve when useAliases is not specified", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_WITH_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/features/page.ts":
        'import { add } from "@/utils/math";\nimport { upper } from "../utils/string";\n',
      "src/utils/string.ts":
        "export function upper(s: string) { return s.toUpperCase(); }\n",
    });

    // No useAliases specified — should default to preserve
    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/features/page.ts": "src/views/page.ts" },
    });
    typecheck();

    const content = readFile("src/views/page.ts");
    // Alias stays alias, relative stays relative
    expect(content).toContain("@/utils/math");
    expect(content).toContain('"../utils/string"');
  });
});

describe("useAliases with no tsconfig paths", () => {
  const TSCONFIG_NO_PATHS = JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      rootDir: "src",
      outDir: "dist",
    },
    include: ["src"],
  });

  it("'always' mode is a no-op when no aliases are configured", () => {
    setupProject({
      "tsconfig.json": TSCONFIG_NO_PATHS,
      "src/utils/math.ts":
        "export function add(a: number, b: number) { return a + b; }\n",
      "src/main.ts":
        'import { add } from "./utils/math";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils/math.ts": "src/lib/math.ts" },
      useAliases: "always",
    });
    typecheck();

    const content = readFile("src/main.ts");
    // No aliases configured, so it stays relative
    expect(content).toContain('"./lib/math"');
  });
});

describe("non-wildcard path alias", () => {
  it("handles exact-match path alias (non-wildcard)", () => {
    setupProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022", module: "ESNext", moduleResolution: "bundler",
          rootDir: "src", outDir: "dist", skipLibCheck: true,
          baseUrl: ".",
          paths: {
            "@config": ["src/config.ts"],
          },
        },
        include: ["src"],
      }),
      "src/config.ts": `export const config = { debug: true };`,
      "src/main.ts": `import { config } from "@config"; export const x = config;`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/config.ts": "src/settings/config.ts",
      },
    });

    // The import should be updated — either the alias is re-mapped or it
    // falls back to a relative path. Non-wildcard (exact) patterns are now
    // handled by parseAliasMappings via isExact, so the alias should resolve.
    const content = readFile("src/main.ts");
    // It should NOT still point to the old unresolvable "@config"
    const stillHasOldAlias = content.includes(`from "@config"`);
    expect(stillHasOldAlias).toBe(false);
  });
});

describe("alias fallback /index stripping", () => {
  it("strips /index from fallback relative path when alias can't be re-expressed", () => {
    const TSCONFIG_STORE_ALIAS = JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        rootDir: "src",
        outDir: "dist",
        skipLibCheck: true,
        baseUrl: ".",
        paths: {
          "~store/*": ["src/store/*"],
        },
      },
      include: ["src"],
    });

    setupProject({
      "tsconfig.json": TSCONFIG_STORE_ALIAS,
      "src/store/index.ts": "export const store = {};\n",
      "src/main.ts": 'import { store } from "~store/index";\nconsole.log(store);\n',
    });

    // Move outside src/store/, so ~store alias can't be re-expressed
    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/store/index.ts": "src/state/index.ts" },
      useAliases: "preserve",
    });

    const content = readFile("src/main.ts");
    // Fallback relative path should be "./state" not "./state/index"
    expect(content).toContain('"./state"');
    expect(content).not.toContain('"./state/index"');
    typecheck();
  });
});

describe("tsconfig extends — aliases from parent config", () => {
  it("resolves path aliases from extended tsconfig", () => {
    setupProject({
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
        },
      }),
      "tsconfig.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: {
          target: "ES2022", module: "ESNext", moduleResolution: "bundler",
          rootDir: "src", outDir: "dist", jsx: "react-jsx", skipLibCheck: true,
        },
        include: ["src"],
      }),
      "src/utils.ts": "export function helper() { return 42; }\n",
      "src/main.ts": 'import { helper } from "@/utils";\nconsole.log(helper());\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    expect(readFile("src/main.ts")).toContain('"@/lib/utils"');
    typecheck();
  });
});
