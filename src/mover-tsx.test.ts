import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { executeMoves } from "./mover.js";
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures-tsx");
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

describe("TSX file handling", () => {
  it("moves .tsx file and updates importers", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/Button.tsx": "export function Button() { return null; }\n",
      "src/App.tsx": 'import { Button } from "./Button";\nexport function App() { return Button(); }\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/Button.tsx": "src/components/Button.tsx" },
    });
    typecheck();

    expect(fileExists("src/components/Button.tsx")).toBe(true);
    expect(fileExists("src/Button.tsx")).toBe(false);
    expect(readFile("src/App.tsx")).toContain('"./components/Button"');
  });

  it("preserves .jsx extension convention for .tsx files", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/Button.tsx": "export function Button() { return null; }\n",
      "src/App.tsx":
        'import { Button } from "./Button.jsx";\nexport function App() { return Button(); }\n',
      "src/Page.tsx":
        'import { Button } from "./Button.jsx";\nexport function Page() { return Button(); }\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/Button.tsx": "src/components/Button.tsx" },
    });
    typecheck();

    expect(fileExists("src/components/Button.tsx")).toBe(true);
    expect(fileExists("src/Button.tsx")).toBe(false);
    // The import should preserve .jsx, not become .js
    expect(readFile("src/App.tsx")).toContain("./components/Button.jsx");
    expect(readFile("src/Page.tsx")).toContain("./components/Button.jsx");
  });

  it("handles mixed .ts and .tsx files in directory move", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/ui/Button.tsx": 'import { cn } from "./utils";\nexport function Button() { return cn(); }\n',
      "src/ui/utils.ts": "export function cn() { return 'cls'; }\n",
      "src/ui/Card.tsx":
        'import { Button } from "./Button";\nexport function Card() { return Button(); }\n',
      "src/main.ts":
        'import { Button } from "./ui/Button";\nimport { Card } from "./ui/Card";\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/ui/": "src/components/" },
    });
    typecheck();

    expect(fileExists("src/components/Button.tsx")).toBe(true);
    expect(fileExists("src/components/utils.ts")).toBe(true);
    expect(fileExists("src/components/Card.tsx")).toBe(true);
    // Internal imports within the moved directory should still work
    expect(readFile("src/components/Button.tsx")).toContain('"./utils"');
    expect(readFile("src/components/Card.tsx")).toContain('"./Button"');
    // External importer should point to new directory
    expect(readFile("src/main.ts")).toContain('"./components/Button"');
    expect(readFile("src/main.ts")).toContain('"./components/Card"');
  });
});
