# ts-shove

Move TypeScript files and directories at scale — all import paths are rewritten automatically via ts-morph AST analysis.

> "We restructured a 300+ file TypeScript codebase — 15 batch moves, 860 tests passing throughout, zero data loss. The tool paid for itself on the first task."
>
> — Claude, Senior Autonomous Refactoring Engineer at Anthropic

## Installation

```bash
pnpm add -D ts-shove
```

Or run directly:

```bash
npx ts-shove <source> <destination>
```

## Quick start

### Move a single file

```bash
ts-shove src/components/Button.tsx src/ui/Button.tsx
```

### Move a directory

Trailing slashes indicate a directory move. All files (TS and non-TS) are moved.

```bash
ts-shove src/components/ src/ui/
```

### Batch move from manifest

```bash
ts-shove moves.json
```

Where `moves.json` contains:

```json
{
  "projectRoot": "/absolute/path/to/project",
  "moves": {
    "src/components/Button.tsx": "src/ui/Button.tsx",
    "src/helpers/": "src/utils/"
  },
  "dryRun": false,
  "useAliases": "preserve"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `projectRoot` | `string` | git root or cwd | Absolute path to project root |
| `moves` | `Record<string, string>` | (required) | Source-to-destination mapping. Trailing `/` = directory move |
| `dryRun` | `boolean` | `false` | Preview without writing changes; detects destination conflicts |
| `useAliases` | `"always" \| "never" \| "preserve"` | `"preserve"` | How to handle path alias imports |

## CLI options

| Flag | Short | Description |
|------|-------|-------------|
| `--dry-run` | `-n` | Preview changes without modifying files; detects destination conflicts |
| `--root <dir>` | `-r` | Project root (default: git root or cwd) |
| `--use-aliases <mode>` | `-a` | Alias handling: `always`, `never`, `preserve` (default: `preserve`) |
| `--help` | `-h` | Show usage information |

## Features

- Rewrites static imports (`import { x } from "./path"`)
- Rewrites dynamic imports (`import("./path")`, including inside `React.lazy()` callbacks)
- Rewrites `require()` calls -- `require("./foo")` with relative paths are rewritten, same as dynamic `import()`
- Rewrites re-exports (`export { x } from "./path"`)
- Rewrites side-effect imports (`import "./styles"`)
- Detects and preserves `.js`/`.jsx` extension convention in import specifiers
- Resolves and rewrites tsconfig path aliases (`@/components/...`)
- Supports both wildcard (`@/*`) and exact-match aliases
- Moves non-TS files (CSS, JSON, SVG, etc.) during directory moves
- Stages moves as git renames for clean history
- Falls back to plain file operations in non-git projects
- Protects against overwriting existing destination files
- Cleans up empty directories after moves
- Handles case-sensitive renames on case-insensitive filesystems (macOS)
- Supports batch moves with correct ordering for overlapping source/destination paths

## Alias handling

The `--use-aliases` flag controls how tsconfig path aliases are treated in import specifiers.

### `preserve` (default)

Alias imports stay as aliases. If the target file moved, the alias path is updated. If the new location can't be expressed as an alias, falls back to a relative path.

```
# Before: import { Button } from "@/components/Button"
# After:  import { Button } from "@/ui/Button"
```

### `always`

All relative imports in affected files are converted to aliases where possible.

```
# Before: import { Button } from "../../ui/Button"
# After:  import { Button } from "@/ui/Button"
```

### `never`

All alias imports in affected files are converted to relative paths.

```
# Before: import { Button } from "@/ui/Button"
# After:  import { Button } from "../../ui/Button"
```

## Dry-run conflict detection

When `--dry-run` (or `dryRun: true` in the manifest) is used, ts-shove checks whether any destination path already exists on disk (and is not itself being moved away). Detected conflicts are reported in the console output and returned in the `MoveResult.conflicts` array. This lets you catch overwrites before any files are touched.

## Programmatic usage

```typescript
import { executeMoves, type MoveManifest, type MoveResult } from "ts-shove";

const result: MoveResult = executeMoves({
  projectRoot: "/path/to/project",
  moves: {
    "src/old.ts": "src/new.ts",
    "src/old-dir/": "src/new-dir/",
  },
  useAliases: "preserve",
});

console.log(`Moved ${result.filesMoved} files, rewrote ${result.importsRewritten} imports`);

if (result.conflicts?.length) {
  console.warn("Destination conflicts:", result.conflicts);
}
```

## What it does NOT handle

- **CSS/SCSS import paths** -- `@import` in stylesheets is not touched.
- **Template literal imports** -- `` import(`./locale/${lang}`) `` is skipped (non-string-literal argument).
- **Runtime string paths** -- Dynamically constructed import paths cannot be statically analyzed.
- **Non-project files** -- Only files included in `tsconfig.json` are analyzed for import rewriting.
- **Git rename tracking** -- Git detects renames by content similarity. When a move rewrites many import lines, the file content may change enough that git no longer recognizes it as a rename, and `git log --follow` won't track the history. This is a fundamental git limitation. For critical files, consider committing the rename and import rewrites as separate steps.

## tsconfig and test files

ts-shove uses ts-morph, which loads the project via `tsconfig.json`. **Only files included by tsconfig are analyzed for import rewriting.** If your tsconfig excludes test files (e.g., `"exclude": ["**/*.test.ts"]`), those files' imports will NOT be updated when you move their dependencies.

If you try to move a file that is excluded from tsconfig, ts-shove will throw an early error:

```
Error: Source file is not included in tsconfig: src/utils.test.ts
ts-morph cannot rewrite imports for files outside the project.
Either add it to tsconfig "include" or use --tsconfig to specify a broader config.
```

**Recommended approach:** Use a tsconfig that includes your test files. Many projects already have a `tsconfig.json` that includes everything and a separate `tsconfig.build.json` for compilation. Point ts-shove at the broader one:

```bash
ts-shove --tsconfig tsconfig.json src/old.ts src/new.ts
```

Or if your main `tsconfig.json` excludes tests, create a `tsconfig.check.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": []
}
```

After a move, ts-shove reports stale-path warnings for string literals (like `vi.mock("./old/path")`) that match moved files but couldn't be automatically rewritten. Review these manually.

## How it works

1. **Expand moves** -- Directory moves are expanded to individual file mappings. Source paths are validated.
2. **Move TS files in-memory** -- ts-morph moves each source file to its destination, automatically rewriting relative imports across the entire project.
3. **Fix .js extensions** -- If the project convention uses `.js` extensions in import specifiers, they are restored (ts-morph strips them).
4. **Fix dynamic imports, `require()` calls, and side-effect imports** -- ts-morph does not handle `import()` expressions, `require()` calls, or imports with no bindings. A separate AST pass rewrites these.
5. **Handle aliases** -- Alias imports pointing to moved files are updated according to the chosen mode.
6. **Write and clean up** -- Changes are saved to disk. Non-TS files are copied. Original files are deleted (via `git rm` when possible). Empty directories are removed.

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Build
pnpm build

# Run in development (without building)
pnpm dev -- <source> <destination>
```

Requires Node.js 20+ and a `tsconfig.json` at the project root.

## Platform support

Tested on macOS and Linux (via CI). Windows is expected to work (all path handling uses Node.js `path` module) but has not been tested. If you encounter Windows-specific issues, please [open an issue](https://github.com/fuerst-one/ts-shove/issues).

## Credits

Built on [ts-morph](https://github.com/dsherret/ts-morph) by David Sherret — the TypeScript AST library that makes all the import rewriting possible.

## License

MIT
