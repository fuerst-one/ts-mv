import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeMoves } from "./mover.js";
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures-errors");
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

describe("source file not found", () => {
  it("throws when source file not found on disk", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/main.ts": "export const x = 1;\n",
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/nonexistent.ts": "src/lib/nonexistent.ts" },
      }),
    ).toThrow("Source file does not exist");
  });

  it("throws error when source directory does not exist", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/index.ts": `export const x = 1;`,
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/nonexistent/": "src/dest/" },
      }),
    ).toThrow();
  });
});

describe("missing tsconfig", () => {
  it("throws when tsconfig.json is missing", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/main.ts": "export const x = 1;\n",
    });

    // Remove tsconfig after setup
    fs.unlinkSync(path.join(TEST_DIR, "tsconfig.json"));

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/main.ts": "src/lib/main.ts" },
      }),
    ).toThrow("No tsconfig.json");
  });
});

describe("no-op move", () => {
  it("handles moving file to same location (no-op)", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/main.ts": 'import { add } from "./utils";\nconsole.log(add(1, 2));\n',
    });

    const originalContent = readFile("src/utils.ts");

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/utils.ts" },
    });
    typecheck();

    expect(fileExists("src/utils.ts")).toBe(true);
    expect(readFile("src/utils.ts")).toBe(originalContent);
    expect(readFile("src/main.ts")).toContain('"./utils"');
  });
});

describe("invalid projectRoot", () => {
  it("rejects moves with clearly invalid projectRoot", () => {
    expect(() =>
      executeMoves({
        projectRoot: "/tmp/ts-mv-nonexistent-dir-" + Date.now(),
        moves: { "src/a.ts": "src/b.ts" },
      }),
    ).toThrow("No tsconfig.json found");
  });
});

describe("cross-project move detection", () => {
  it("throws when destination is outside projectRoot", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/utils.ts": "../other-project/src/utils.ts" },
      }),
    ).toThrow();
  });

  it("throws when source is outside projectRoot", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "../other-project/src/utils.ts": "src/utils.ts" },
      }),
    ).toThrow();
  });

  it("allows moves within projectRoot subdirectories", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": 'import { x } from "./utils";\n',
    });

    // Should NOT throw — both paths are within projectRoot
    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });
    typecheck();

    expect(result.filesMoved).toBe(1);
  });
});

describe("overwrite protection: single file", () => {
  it("throws when destination file already exists", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/main.ts": 'import { a } from "./a";\nconsole.log(a);\n',
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/a.ts": "src/b.ts" },
      }),
    ).toThrow();

    expect(readFile("src/b.ts")).toContain("export const b = 2");
  });

  it("throws when destination file already exists (different directory)", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function rootUtil() { return 1; }\n",
      "src/lib/utils.ts": "export function libUtil() { return 2; }\n",
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/utils.ts": "src/lib/utils.ts" },
      }),
    ).toThrow();

    expect(readFile("src/lib/utils.ts")).toContain("export function libUtil()");
  });
});

describe("overwrite protection: directory move", () => {
  it("throws when directory move would overwrite existing files", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/old/a.ts": "export const oldA = 1;\n",
      "src/old/b.ts": "export const oldB = 2;\n",
      "src/new/a.ts": "export const newA = 999;\n",
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/old/": "src/new/" },
      }),
    ).toThrow();

    expect(readFile("src/new/a.ts")).toContain("export const newA = 999");
    expect(fileExists("src/old/a.ts")).toBe(true);
  });

  it("allows directory move into empty destination directory", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/old/a.ts": "export const a = 1;\n",
      "src/old/b.ts": "export const b = 2;\n",
    });

    // Create empty destination directory
    fs.mkdirSync(path.join(TEST_DIR, "src", "new"), { recursive: true });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/old/": "src/new/" },
    });

    typecheck();

    expect(fileExists("src/new/a.ts")).toBe(true);
    expect(fileExists("src/new/b.ts")).toBe(true);
  });

  it("allows directory move when destination directory doesn't exist yet", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/old/a.ts": "export const a = 1;\n",
      "src/old/b.ts": "export const b = 2;\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/old/": "src/new/" },
    });

    typecheck();

    expect(fileExists("src/new/a.ts")).toBe(true);
    expect(fileExists("src/new/b.ts")).toBe(true);
    expect(fileExists("src/old/a.ts")).toBe(false);
  });

  it("does not overwrite existing non-TS files in directory move", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/old/style.css": "OLD CSS",
      "src/old/component.tsx": "export const Component = () => <div>hello</div>;\n",
      "src/new/style.css": "NEW CSS",
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/old/": "src/new/" },
      }),
    ).toThrow();

    expect(readFile("src/new/style.css")).toBe("NEW CSS");
  });
});

describe("overwrite protection: batch moves", () => {
  it("throws when batch move would overwrite an unmoved file", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": 'import { b } from "./b";\nconsole.log(b);\n',
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/a.ts": "src/b.ts" },
      }),
    ).toThrow();

    expect(readFile("src/b.ts")).toContain("export const b = 2");
  });

  it("batch move where two files swap locations is NOT supported (would require temp)", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: {
          "src/a.ts": "src/b.ts",
          "src/b.ts": "src/a.ts",
        },
      }),
    ).toThrow();
  });
});

describe("overwrite protection: dest is directory", () => {
  it("throws when destination path is an existing directory", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export const util = 1;\n",
      "src/lib/index.ts": "export const lib = 1;\n",
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/utils.ts": "src/lib/" },
      }),
    ).toThrow();
  });
});

describe("dry run bypasses dest conflict checks", () => {
  it("dry run reports moves even when destination exists", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/a.ts": "src/b.ts" },
      dryRun: true,
    });

    // Dry run just previews and returns early without validating conflicts
    expect(result.filesMoved).toBe(0);

    // Both files should be untouched
    expect(readFile("src/a.ts")).toContain("export const a = 1");
    expect(readFile("src/b.ts")).toContain("export const b = 2");
  });
});

describe("dry run conflict detection", () => {
  it("dry run detects destination conflicts", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    });

    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/a.ts": "src/b.ts" },
      dryRun: true,
    });

    // Dry run should detect and report the conflict (e.g. via a conflicts field or warning)
    // Currently dry run does zero validation — this test documents the desired behavior
    expect(result).toHaveProperty("conflicts");
  });
});

describe("overwrite error messages", () => {
  it("throws descriptive error when TS file destination already exists", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    });

    expect(() => {
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/a.ts": "src/b.ts" },
      });
    }).toThrow(/already exists|[Dd]estination/);
  });
});

describe("pre-validation of all destinations", () => {
  it("validates all destinations before starting any moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": "export const c = 3;\n",
      "src/existing.ts": "export const existing = 99;\n",
    });

    expect(() => {
      executeMoves({
        projectRoot: TEST_DIR,
        moves: {
          "src/a.ts": "src/lib/a.ts",
          "src/b.ts": "src/lib/b.ts",
          "src/c.ts": "src/existing.ts", // conflict
        },
      });
    }).toThrow();

    // Pre-validation should reject before any moves happen.
    // First two source files must still exist at their original locations
    // AND their destinations must NOT exist (proving no partial work was done).
    expect(fileExists("src/a.ts")).toBe(true);
    expect(fileExists("src/b.ts")).toBe(true);
    expect(fileExists("src/lib/a.ts")).toBe(false);
    expect(fileExists("src/lib/b.ts")).toBe(false);
  });
});

describe("custom tsconfig path", () => {
  it("uses custom tsconfig path when specified", () => {
    setupProject({
      "tsconfig.check.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/main.ts": 'import { add } from "./utils";\nconsole.log(add(1, 2));\n',
    });

    // Remove the default tsconfig.json that setupProject may have created
    const defaultTsconfig = path.join(TEST_DIR, "tsconfig.json");
    if (fs.existsSync(defaultTsconfig)) {
      fs.unlinkSync(defaultTsconfig);
    }

    // Should work with the custom tsconfig path — should NOT throw "No tsconfig.json found"
    const result = executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
      tsConfigPath: "tsconfig.check.json",
    });

    expect(result.filesMoved).toBe(1);
  });

  it("throws when specified tsconfig does not exist", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
    });

    expect(() =>
      executeMoves({
        projectRoot: TEST_DIR,
        moves: { "src/utils.ts": "src/lib/utils.ts" },
        tsConfigPath: "nonexistent.json",
      }),
    ).toThrow(/nonexistent\.json|tsconfig/i);
  });
});

describe("syntax errors in project", () => {
  it("handles project with syntax errors in unrelated files", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/broken.ts": "export const x: = 1;\n",
      "src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/main.ts": 'import { add } from "./utils";\nconsole.log(add(1, 2));\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    expect(fileExists("src/lib/utils.ts")).toBe(true);
    expect(readFile("src/main.ts")).toContain('"./lib/utils"');
    // Skip typecheck — project has intentional syntax error
  });
});
