import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { executeMoves } from "./mover.js";
import { computeNewImportPath } from "./resolver.js";
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures-batch");
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

describe("cross-import between moved files", () => {
  it("two files that import each other, both moved to same directory", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": 'import { b } from "./b";\nexport const a = b + 1;\n',
      "src/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/a.ts": "src/lib/a.ts",
        "src/b.ts": "src/lib/b.ts",
      },
    });
    typecheck();

    // Both moved to same directory — relative imports should stay as sibling refs
    expect(readFile("src/lib/a.ts")).toContain('"./b"');
    expect(readFile("src/lib/b.ts")).toContain('"./a"');
  });

  it("moved files at different depth levels", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": 'import { b } from "./deep/b";\nexport const a = b + 1;\n',
      "src/deep/b.ts": "export const b = 42;\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/a.ts": "src/layer1/a.ts",
        "src/deep/b.ts": "src/layer2/b.ts",
      },
    });
    typecheck();

    expect(readFile("src/layer1/a.ts")).toContain('"../layer2/b"');
  });
});

describe("return value", () => {
  it("returns correct filesMoved count", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": "export const c = 3;\n",
    });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/a.ts": "src/lib/a.ts",
        "src/b.ts": "src/lib/b.ts",
        "src/c.ts": "src/lib/c.ts",
      },
    });
    typecheck();

    expect(result.filesMoved).toBe(3);
  });
});

describe("large batch move", () => {
  it("handles batch move of 10+ interdependent files", () => {
    const files: Record<string, string> = {
      "tsconfig.json": TSCONFIG,
      "src/mod1.ts": "export const mod1 = 1;\n",
    };

    // mod2..mod10 each import from previous
    for (let i = 2; i <= 10; i++) {
      files[`src/mod${i}.ts`] = `import { mod${i - 1} } from "./mod${i - 1}";\nexport const mod${i} = mod${i - 1} + 1;\n`;
    }
    files["src/main.ts"] = 'import { mod10 } from "./mod10";\nconsole.log(mod10);\n';

    setupProject(files);

    const moves: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) {
      moves[`src/mod${i}.ts`] = `src/lib/mod${i}.ts`;
    }

    executeMoves({
      projectRoot: TEST_DIR,
      moves,
    });

    // All files should be moved
    for (let i = 1; i <= 10; i++) {
      expect(fileExists(`src/lib/mod${i}.ts`)).toBe(true);
      expect(fileExists(`src/mod${i}.ts`)).toBe(false);
    }

    // Chain imports within lib/ should be correct (same directory, so ./modN)
    for (let i = 2; i <= 10; i++) {
      const content = readFile(`src/lib/mod${i}.ts`);
      expect(content).toContain(`"./mod${i - 1}"`);
    }

    // main.ts should import from ./lib/mod10
    expect(readFile("src/main.ts")).toContain('"./lib/mod10"');

    typecheck();
  });
});

describe("circular imports", () => {
  it("circular imports between files moved to different directories", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": 'import { b } from "./b";\nexport const a = b + 1;\n',
      "src/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/a.ts": "src/x/a.ts",
        "src/b.ts": "src/y/b.ts",
      },
    });

    expect(fileExists("src/x/a.ts")).toBe(true);
    expect(fileExists("src/y/b.ts")).toBe(true);
    expect(fileExists("src/a.ts")).toBe(false);
    expect(fileExists("src/b.ts")).toBe(false);

    expect(readFile("src/x/a.ts")).toContain('"../y/b"');
    expect(readFile("src/y/b.ts")).toContain('"../x/a"');
    typecheck();
  });
});

describe("mixed moved and unmoved imports", () => {
  it("correctly updates only the moved import, leaves unmoved import alone", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/main.ts": 'import { a } from "./a";\nimport { b } from "./b";\nconsole.log(a, b);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/a.ts": "src/lib/a.ts" },
    });

    const mainContent = readFile("src/main.ts");
    expect(mainContent).toContain('"./lib/a"');
    expect(mainContent).toContain('"./b"');
    typecheck();
  });
});

describe("widely-imported file move", () => {
  it("updates all importers when a widely-imported file moves", () => {
    const files: Record<string, string> = {
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function util() { return 42; }\n",
    };

    for (const name of ["a", "b", "c", "d", "e"]) {
      files[`src/${name}.ts`] = `import { util } from "./utils";\nexport const ${name} = util();\n`;
    }

    setupProject(files);

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/core/utils.ts" },
    });

    for (const name of ["a", "b", "c", "d", "e"]) {
      expect(readFile(`src/${name}.ts`)).toContain('"./core/utils"');
    }
    typecheck();
  });
});

describe("overlapping source and dest directories", () => {
  it("handles overlapping source and dest directories in batch move", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/old/a.ts": "export const a = 1;\n",
      "src/temp/b.ts": 'import { a } from "../old/a";\nexport const b = a + 1;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/old/a.ts": "src/temp/a.ts",
        "src/temp/b.ts": "src/new/b.ts",
      },
    });

    expect(fileExists("src/temp/a.ts")).toBe(true);
    expect(fileExists("src/new/b.ts")).toBe(true);
    expect(fileExists("src/old/a.ts")).toBe(false);
    expect(fileExists("src/temp/b.ts")).toBe(false);

    // b.ts moved to src/new/b.ts should import from ../temp/a
    expect(readFile("src/new/b.ts")).toContain('"../temp/a"');
    typecheck();
  });
});

describe("batch move ordering", () => {
  it("handles batch where one move's destination was another's source path", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/old.ts": "export const old = 1;\n",
      "src/other.ts": "export const other = 2;\n",
      "src/main.ts": 'import { old } from "./old";\nimport { other } from "./other";\nexport const sum = old + other;\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/old.ts": "src/archive/old.ts",
        "src/other.ts": "src/old.ts",
      },
    });

    expect(fileExists("src/archive/old.ts")).toBe(true);
    expect(fileExists("src/old.ts")).toBe(true);

    const mainContent = readFile("src/main.ts");
    expect(mainContent).toContain('"./archive/old"');
    expect(mainContent).toContain('"./old"');
    typecheck();
  });
});

describe("3-move chain", () => {
  it("handles 3-move chain where A→B, B→C, C→D", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": "export const c = 3;\n",
      "src/main.ts": 'import { a } from "./a";\nimport { b } from "./b";\nimport { c } from "./c";\nconsole.log(a, b, c);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/a.ts": "src/b.ts",
        "src/b.ts": "src/c.ts",
        "src/c.ts": "src/d.ts",
      },
    });

    // All three files should end up at correct destinations
    expect(fileExists("src/b.ts")).toBe(true);
    expect(fileExists("src/c.ts")).toBe(true);
    expect(fileExists("src/d.ts")).toBe(true);

    expect(readFile("src/b.ts")).toContain("export const a = 1");
    expect(readFile("src/c.ts")).toContain("export const b = 2");
    expect(readFile("src/d.ts")).toContain("export const c = 3");

    // main.ts imports should be updated
    const mainContent = readFile("src/main.ts");
    expect(mainContent).toContain('"./b"');
    expect(mainContent).toContain('"./c"');
    expect(mainContent).toContain('"./d"');

    typecheck();
  });
});

describe("empty moves map", () => {
  it("empty moves map is a no-op", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/main.ts": "export const x = 1;\n",
    });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: {},
    });

    expect(result.filesMoved).toBe(0);
    expect(readFile("src/main.ts")).toBe("export const x = 1;\n");
  });
});

describe("importsRewritten return value", () => {
  it("returns non-negative importsRewritten count", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./utils";\nconsole.log(x);\n',
    });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    // ts-morph rewrites 1 static import in main.ts — importsRewritten should reflect that
    expect(result.importsRewritten).toBeGreaterThanOrEqual(1);
  });

  it("dry run returns importsRewritten: 0", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": `import { b } from "./b"; export const a = b;`,
      "src/b.ts": `export const b = 1;`,
    });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/a.ts": "src/sub/a.ts" },
      dryRun: true,
    });

    expect(result.importsRewritten).toBe(0);
  });

  it("importsRewritten counts at least ts-morph static import rewrites", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/consumer1.ts": 'import { x } from "./utils";\nexport const c1 = x;\n',
      "src/consumer2.ts": 'import { x } from "./utils";\nexport const c2 = x;\n',
      "src/consumer3.ts": 'import { x } from "./utils";\nexport const c3 = x;\n',
    });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    // At minimum the 3 static imports should be counted
    expect(result.importsRewritten).toBeGreaterThanOrEqual(3);
  });
});

describe("computeNewImportPath .tsx edge case", () => {
  it("computeNewImportPath returns .jsx for .tsx targets when usesJsExtension is true", () => {
    const result = computeNewImportPath(
      "/project/src/main.ts",
      "/project/src/Button.tsx",
      true,
    );
    // Should end with .jsx, not .js, because the target is a .tsx file
    expect(result).toBe("./Button.jsx");
    expect(result).not.toMatch(/\.js$/);
  });
});
