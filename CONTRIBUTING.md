# Contributing

Thanks for your interest in contributing to ts-mv!

## Development setup

```bash
git clone https://github.com/fuerst-one/ts-mv.git
cd ts-mv
pnpm install
```

## Running tests

```bash
pnpm test          # Run all tests once
pnpm test:watch    # Run tests in watch mode
```

## Building

```bash
pnpm build
```

## Project structure

```
src/
  cli.ts          # CLI entry point and argument parsing
  mover.ts        # Core move logic and import rewriting pipeline
  resolver.ts     # Path resolution utilities
  test-helpers.ts # Shared test utilities
  *.test.ts       # Test files organized by theme
```

## How the pipeline works

1. Expand moves (directory → individual files)
2. Move TS files in-memory via ts-morph (rewrites static imports)
3. Fix .js extensions (ts-morph strips them)
4. Fix dynamic imports, require() calls, and side-effect imports
5. Handle alias imports based on chosen mode
6. Write to disk, stage in git, clean up empty directories

## Writing tests

Tests use vitest and create real filesystem fixtures with tsconfig.json and git repos. Each test file has its own fixture directory under `.test/`.

Use the shared helpers from `test-helpers.ts`:

```typescript
import { createTestHelpers } from "./test-helpers.js";

const TEST_DIR = path.join(import.meta.dirname, "..", ".test", "fixtures-mytest");
const { setupProject, readFile, fileExists, typecheck, cleanup } = createTestHelpers(TEST_DIR);
```

Always call `typecheck()` after successful moves to verify TypeScript AST integrity. Add a comment if you skip it (e.g., `// Skip typecheck — require() in ESM mode`).

## Pull requests

- Add tests for new behavior (TDD preferred)
- Run `pnpm test` before submitting
- Keep changes focused — one feature or fix per PR
