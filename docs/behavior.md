# Detailed behavior reference

## Import rewriting pipeline

When `executeMoves()` is called, the following steps execute in order:

### Step 1: Expand moves

`expandMoves()` converts the user-provided move map into absolute paths.

- **File moves**: validated to exist and resolved against project root.
- **Directory moves** (trailing `/`): all files within the directory are enumerated recursively via `findAllFiles()`, which includes non-TS files (CSS, JSON, SVG, images, etc.). Each file gets its own entry in the expanded map.
- **Boundary check**: both source and destination must be within `projectRoot`. An error is thrown otherwise.

### Step 2: Move TS files in-memory

A `ts-morph` `Project` is loaded from the project's `tsconfig.json`. Each `.ts`/`.tsx` source file in the move map is moved to its destination using `sourceFile.move()`.

ts-morph automatically rewrites all relative imports across the entire project that reference the moved file. This is the core mechanism -- ts-morph's type-aware analysis ensures that imports in files you did not move are also updated.

**Move ordering**: entries are sorted so that files whose source path is a destination of another move are processed first. This prevents "file already exists" errors in overlapping move chains.

**Overwrite logic**: `move()` is called with `overwrite: true` only when the destination path exists on disk but has already been moved away in-memory (i.e., the on-disk file is stale).

### Step 3: Fix .js extensions

ts-morph's `move()` strips `.js`/`.jsx` extensions from import specifiers. If the project uses `.js` extensions (detected in Step 0), this pass restores them.

Applies to `import` declarations, `export` declarations with module specifiers, and dynamic `import()` / `require()` call expressions. Skips specifiers that already end in `.js`/`.jsx` or have a non-TS extension (e.g., `.css`, `.json`).

The correct extension is determined from the target file: `.tsx` source files get `.jsx`, everything else gets `.js`.

### Step 3b: Strip `/index` from dynamic import and require specifiers

ts-morph v25+ may produce `./dir/index` (or `./dir/index.js`) instead of `./dir` when rewriting dynamic `import()` and `require()` calls that target directory index files. This pass strips the `/index` suffix to maintain clean specifiers.

### Step 4: Fix dynamic imports and require() calls

ts-morph does not rewrite `import()` expressions or `require()` calls. This pass walks the AST of every source file, finding `CallExpression` nodes where the expression is `ImportKeyword` (for dynamic imports) or an `Identifier` named `require` (for CommonJS requires).

For each call with a string literal specifier (relative path or alias):
1. The specifier is resolved from the file's **original** location (before the move). Alias specifiers are resolved via the parsed tsconfig path mappings.
2. The target file's new location is looked up in the move map.
3. A new specifier is computed from the importing file's **new** location -- as an alias (depending on `useAliases` mode) or as a relative path.

This handles `React.lazy(() => import("./Component"))` and similar patterns because the pass uses `getDescendantsOfKind` which recursively walks the full AST tree.

### Step 5: Fix side-effect imports

Imports with no bindings (`import "./styles"`) are not tracked by ts-morph's move logic because they have no symbol references. This pass identifies them by checking for imports with:
- No named imports
- No default import
- No namespace import

These are resolved against the move map and rewritten if their target moved.

### Step 6: Handle aliases

Based on the `useAliases` mode, alias imports are processed. See [Alias resolution](#alias-resolution) below for details.

### Step 7: Write to disk and clean up

1. `project.saveSync()` writes all modified TS files.
2. Non-TS files are copied to their destinations (with overwrite protection).
3. Original files are deleted. In git repos, this is done via `git add <dest>` + `git rm <src>` to stage the move as a rename. Falls back to `fs.unlinkSync` if git commands fail or the project is not a git repo.
4. Empty source directories are removed by walking up from each source file's directory toward the project root.

## Conflict detection (dry-run)

When `dryRun` is `true`, `executeMoves()` checks each destination path against the filesystem. If a destination already exists and is not itself being moved away (i.e., it is not a source in the move map), it is flagged as a conflict.

Conflicts are printed to the console and returned in the `MoveResult.conflicts` array. When no conflicts are found, the `conflicts` field is `undefined`.

No files are moved or modified during a dry run -- the function returns early after printing the move plan and any detected conflicts.

## Extension convention detection

`detectJsExtensionConvention()` samples up to 30 source files from the project. For each relative import specifier, it checks whether it ends in `.js` or `.jsx`.

The convention is considered "uses .js extensions" if more than 50% of relative imports have a `.js`/`.jsx` extension. This threshold-based approach handles mixed codebases gracefully.

**Sampling limit**: only the first 30 source files (as returned by `project.getSourceFiles()`) are checked. In very large projects, this sample may not represent the full codebase.

## Directory moves

When a move entry has a trailing `/`, it is treated as a directory move:

1. `findAllFiles()` recursively enumerates all files in the source directory.
2. Each file is mapped to its corresponding destination by preserving the relative path within the directory.
3. TS files (`.ts`, `.tsx`) are moved via ts-morph with full import rewriting.
4. Non-TS files (CSS, JSON, SVG, images, etc.) are copied with `fs.copyFileSync`.
5. `.d.ts` files are excluded from the ts-morph project but are still moved as regular files.

`findAllFiles()` uses `entry.isFile()` which returns `false` for symlinks, so symlinks within a directory are skipped.

## Alias resolution

### Parsing tsconfig paths

`parseAliasMappings()` reads `compilerOptions.paths` from the project's tsconfig. Two forms are supported:

**Wildcard aliases** (e.g., `"@/*": ["./src/*"]`):
- The `*` suffix is stripped to get the prefix (`@/`) and base directory (`./src`).
- Any import starting with `@/` maps to the `src/` directory.

**Exact aliases** (e.g., `"@config": ["./src/config.ts"]`):
- Marked with `isExact: true`.
- Only matches the literal specifier `@config`, not `@config/sub`.

Mappings are sorted by base directory length (descending) so the most specific alias is matched first.

### The expand-move-re-alias pipeline

When processing alias imports for moved files:

1. **Resolve**: the alias specifier is resolved to an absolute file path using `resolveAliasToAbsolute()`.
2. **Lookup**: the resolved path is checked against the move map to find its new location.
3. **Re-alias**: `absolutePathToAlias()` attempts to express the new location as an alias. If successful, the import is updated to the new alias. If the new location falls outside all alias base directories, a relative path is used instead.

### Mode behavior

- **preserve**: alias imports stay as aliases when possible. Only imports pointing to moved files are touched. Relative imports stay relative.
- **always**: relative imports in affected files are converted to aliases. Alias imports pointing to moved files are updated.
- **never**: alias imports in affected files are converted to relative paths.

"Affected files" means files that were moved or that import a moved file.

## Git integration

### Rename detection

After writing files to disk, originals are deleted using:

```
git add <destination>
git rm <source>
```

This stages the operation as a rename, so `git diff --staged` and `git log --follow` correctly track the file's history.

### Non-git fallback

If `git rev-parse --is-inside-work-tree` fails (not a git repo), or if the `git add`/`git rm` commands fail, the tool falls back to `fs.unlinkSync()` for deletion.

### Project root detection

When no `--root` is specified, the CLI walks up from `cwd` looking for a `.git` directory. If none is found, `cwd` is used as the project root.

## Overwrite protection

- **TS files**: ts-morph's `move()` is called without `overwrite` by default. If the destination file already exists in the project and was not moved away, ts-morph throws an error.
- **Non-TS files**: before copying, `fs.existsSync(dest)` is checked. If the destination exists, an error is thrown: `"Destination file already exists: <path>"`.
- **Exception**: when a destination path is also a source of another move that has already been processed, `overwrite: true` is passed to ts-morph because the on-disk file is stale.

## Empty directory cleanup

After all files are moved and originals deleted, the tool collects the parent directories of all source files. These are sorted by path length (longest first) to process deepest directories first.

For each directory, it walks upward toward the project root:
1. Reads the directory entries.
2. If empty, removes it with `fs.rmdirSync()` and logs the removal.
3. If not empty, stops walking up.
4. Never removes the project root itself.

## Batch move ordering

When multiple moves are specified, there can be overlapping source and destination paths (e.g., file A moves to where file B is, and file B moves elsewhere).

The sort ensures files whose source path is also a destination of another move are processed first. This guarantees that by the time ts-morph tries to move a file to a location, the previous occupant has already been moved away.

## Case-sensitive renames

On case-insensitive filesystems (macOS HFS+/APFS), renaming `Button.tsx` to `button.tsx` fails because the OS considers them the same file.

The tool detects case-only renames (`src.toLowerCase() === dest.toLowerCase() && src !== dest`) and performs a two-step move:

1. Move to a temporary path: `<dest>.__ts_mv_tmp__`
2. Move from the temporary path to the final destination.

This ensures ts-morph sees two distinct paths. The original file is not deleted separately for case renames (the `isCaseRename` check skips the deletion step since the OS-level rename already handled it).

## Error handling

| Condition | Error message |
|-----------|--------------|
| No `tsconfig.json` at project root | `No tsconfig.json found at <path>` |
| Source path outside project root | `Source path is outside project root: <path>` |
| Destination path outside project root | `Destination path is outside project root: <path>` |
| Source file does not exist | `Source file does not exist: <path>` |
| Source directory does not exist | `Source directory does not exist: <path>` |
| Non-TS destination already exists | `Destination file already exists: <path>` |
| Manifest file not found (CLI) | `Manifest not found: <path>` |
| Invalid `--use-aliases` value (CLI) | `Invalid --use-aliases value: <val>. Expected: always, never, preserve` |

Files not found in the ts-morph project emit a warning and are skipped rather than throwing an error.
