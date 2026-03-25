import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { executeMoves } from "./mover.js";
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures-dynamic");
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

describe("dynamic import edge cases", () => {
  it("updates dynamic import with .js extension", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/plugin.ts": "export function activate() { return true; }\n",
      "src/loader.ts":
        'import { activate } from "./plugin.js";\nconst m = await import("./plugin.js");\nconsole.log(activate, m);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/plugin.ts": "src/plugins/plugin.ts" },
    });
    typecheck();

    const content = readFile("src/loader.ts");
    expect(content).toContain('import("./plugins/plugin.js")');
  });

  it("skips dynamic import with non-literal specifier", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/plugin.ts": "export function activate() { return true; }\n",
      "src/loader.ts":
        'const name = "plugin";\nconst m = await import(`.//${name}`);\nconsole.log(m);\n',
    });

    // Move some file, just to exercise the code path — should not crash
    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/plugin.ts": "src/plugins/plugin.ts" },
    });
    // Skip typecheck — template literal import won't typecheck

    // The template literal import should be left untouched
    const content = readFile("src/loader.ts");
    expect(content).toContain("import(`.//${name}`)");
  });

  it("updates dynamic import to directory index", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/store/index.ts":
        "export const store = { count: 0 };\n",
      "src/main.ts":
        'export const mod = await import("./store");\nconsole.log(mod);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/store/": "src/state/" },
    });
    typecheck();

    expect(readFile("src/main.ts")).toContain('import("./state")');
  });
});

describe("dynamic imports in various patterns", () => {
  it("updates import() inside React.lazy callback", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/App.tsx": [
        `const React = { lazy: (fn: () => Promise<any>) => fn };`,
        `export const LazyPage = React.lazy(() => import("./pages/Home"));`,
      ].join("\n"),
      "src/pages/Home.tsx": `export default function Home() { return null; }`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/pages/Home.tsx": "src/views/Home.tsx" },
    });

    const app = readFile("src/App.tsx");
    expect(app).toContain(`import("./views/Home")`);
    typecheck();
  });

  it("updates import() inside a generic wrapper function", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/loader.ts": [
        `export function loadModule(loader: () => Promise<any>) { return loader(); }`,
        `export const mod = loadModule(() => import("./plugins/analytics"));`,
      ].join("\n"),
      "src/plugins/analytics.ts": `export const track = () => {};`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/plugins/analytics.ts": "src/features/analytics.ts" },
    });

    const loader = readFile("src/loader.ts");
    expect(loader).toContain(`import("./features/analytics")`);
    typecheck();
  });

  it("updates import() inside async function body", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/main.ts": [
        `export async function loadPlugin() {`,
        `  const mod = await import("./plugin");`,
        `  return mod;`,
        `}`,
      ].join("\n"),
      "src/plugin.ts": `export const name = "test";`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/plugin.ts": "src/plugins/plugin.ts" },
    });

    const main = readFile("src/main.ts");
    expect(main).toContain(`import("./plugins/plugin")`);
    typecheck();
  });

  it("updates multiple dynamic imports in same file", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/router.ts": [
        `export const routes = {`,
        `  home: () => import("./pages/home"),`,
        `  about: () => import("./pages/about"),`,
        `  contact: () => import("./pages/contact"),`,
        `};`,
      ].join("\n"),
      "src/pages/home.ts": `export default {};`,
      "src/pages/about.ts": `export default {};`,
      "src/pages/contact.ts": `export default {};`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/pages/": "src/views/" },
    });

    const router = readFile("src/router.ts");
    expect(router).toContain(`import("./views/home")`);
    expect(router).toContain(`import("./views/about")`);
    expect(router).toContain(`import("./views/contact")`);
    typecheck();
  });

  it("updates dynamic import with .js extension when moving directory", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/main.ts": [
        `import { x } from "./utils.js";`,
        `export const loader = () => import("./pages/home.js");`,
        `export { x };`,
      ].join("\n"),
      "src/utils.ts": `export const x = 1;`,
      "src/pages/home.ts": `export default {};`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/pages/": "src/views/" },
    });

    const main = readFile("src/main.ts");
    expect(main).toContain(`import("./views/home.js")`);
    typecheck();
  });

  it("updates import() in ternary/conditional expression", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/main.ts": [
        `export const isAdmin = true;`,
        `export const mod = isAdmin ? import("./admin") : import("./user");`,
      ].join("\n"),
      "src/admin.ts": `export default {};`,
      "src/user.ts": `export default {};`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: {
        "src/admin.ts": "src/roles/admin.ts",
        "src/user.ts": "src/roles/user.ts",
      },
    });

    const main = readFile("src/main.ts");
    expect(main).toContain(`import("./roles/admin")`);
    expect(main).toContain(`import("./roles/user")`);
    typecheck();
  });

  it("does not modify dynamic import when target is not moved", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/main.ts": `export const m = import("./utils");`,
      "src/utils.ts": `export default {};`,
      "src/other.ts": `export const y = 1;`,
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/other.ts": "src/lib/other.ts" },
    });

    const main = readFile("src/main.ts");
    expect(main).toContain(`import("./utils")`);
    typecheck();
  });
});

describe("React.lazy and next/dynamic patterns", () => {
  it("updates next/dynamic(() => import('./Component')) style dynamic imports", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/app/page.tsx": [
        'const dynamic = (fn: () => Promise<any>) => fn;',
        'export const DynamicChart = dynamic(() => import("../components/Chart"));',
        "",
      ].join("\n"),
      "src/components/Chart.tsx": "export default function Chart() { return null; }\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/components/Chart.tsx": "src/ui/Chart.tsx" },
    });

    const content = readFile("src/app/page.tsx");
    expect(content).toContain('import("../ui/Chart")');
    typecheck();
  });
});

describe("/index stripping safety", () => {
  it("does NOT strip /index from dynamic imports that originally had /index", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/server/index.ts": "export function startServer() { return true; }\n",
      "src/server/routes.ts": "export const routes = [];\n",
      "src/main.ts": [
        'const { startServer } = await import("./server/index");',
        'export { startServer };',
      ].join("\n"),
    });

    // Move an unrelated file in the same project — the /index import should NOT be touched
    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/server/routes.ts": "src/server/api/routes.ts" },
    });

    const content = readFile("src/main.ts");
    // The original import("./server/index") must be preserved as-is
    expect(content).toContain('import("./server/index")');
    expect(content).not.toContain('import("./server")');
  });

  it("does NOT strip /index.js from dynamic imports that originally had /index.js", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "src/c.ts": "export const c = 1;\n",
      "src/server/index.ts": "export function start() { return true; }\n",
      "src/main.ts": [
        'import { a } from "./a.js";',
        'export const srv = import("./server/index.js");',
        'export { a };',
      ].join("\n"),
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/c.ts": "src/lib/c.ts" },
    });

    const content = readFile("src/main.ts");
    // The original import("./server/index.js") must be preserved
    expect(content).toContain('import("./server/index.js")');
    expect(content).not.toContain('import("./server.js")');
  });

  it("DOES strip /index when ts-morph introduced it during a move", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/store/index.ts": "export const store = { count: 0 };\n",
      "src/main.ts": 'export const mod = await import("./store");\nconsole.log(mod);\n',
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/store/": "src/state/" },
    });
    typecheck();

    // ts-morph rewrites ./store to ./state/index — we should strip back to ./state
    expect(readFile("src/main.ts")).toContain('import("./state")');
  });
});

describe("inline type imports", () => {
  it("preserves .js extension in inline type import after move", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      // 3 files with .js imports to establish ESM convention
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "src/c.ts": "export const c = 1;\n",
      "src/types.ts": "export type TaskRef = { id: string };\n",
      "src/utils.ts": "export const x = 1;\n",
      "src/main.ts": [
        'import { x } from "./utils.js";',
        'const ref: import("./types.js").TaskRef = { id: "1" };',
        "export { x, ref };",
      ].join("\n") + "\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/utils.ts": "src/lib/utils.ts" },
    });

    const content = readFile("src/main.ts");
    // The inline type import must still have .js — not stripped to import("./types")
    expect(content).toContain('import("./types.js").TaskRef');
  });

  it("rewrites inline type import path when target moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      "src/types.ts": "export type TaskRef = { id: string };\n",
      "src/main.ts": [
        'const ref: import("./types").TaskRef = { id: "1" };',
        "export { ref };",
      ].join("\n") + "\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/types.ts": "src/lib/types.ts" },
    });

    const content = readFile("src/main.ts");
    // The inline type import path should be updated
    expect(content).toContain('import("./lib/types").TaskRef');
  });

  it("rewrites inline type import path with .js extension when target moves", () => {
    setupProject({
      "tsconfig.json": TSCONFIG,
      // 3 files with .js imports to establish ESM convention
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "src/c.ts": "export const c = 1;\n",
      "src/types.ts": "export type TaskRef = { id: string };\n",
      "src/main.ts": [
        'const ref: import("./types.js").TaskRef = { id: "1" };',
        "export { ref };",
      ].join("\n") + "\n",
    });

    executeMoves({
      projectRoot: TEST_DIR,
      moves: { "src/types.ts": "src/lib/types.ts" },
    });

    const content = readFile("src/main.ts");
    // The inline type import should be rewritten with .js extension preserved
    expect(content).toContain('import("./lib/types.js").TaskRef');
  });
});
