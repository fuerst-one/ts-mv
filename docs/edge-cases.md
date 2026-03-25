# Known edge cases and limitations

## Non-TS imports (CSS, JSON, SVG)

**Behavior**: during directory moves, non-TS files are copied to their new locations. However, import paths referencing these files are **not** rewritten in TS source files.

**Why**: ts-morph only tracks `.ts`/`.tsx` files. Imports like `import "./styles.css"` or `import data from "./data.json"` are opaque strings to the tool.

**Workaround**: after a move, search for broken non-TS imports manually. The `.js` extension fix pass explicitly skips specifiers with non-TS extensions (`.css`, `.json`, `.svg`, etc.) to avoid corrupting them.

## Side-effect imports

**Behavior**: imports with no bindings (`import "./polyfill"`, `import "./styles"`) are handled by a dedicated pass.

**Why**: ts-morph's `move()` only rewrites imports that have symbol bindings (named, default, or namespace imports). Side-effect imports have no bindings, so ts-morph ignores them.

**Detection**: the pass checks `getNamedImports().length === 0`, `getDefaultImport() === undefined`, and `getNamespaceImport() === undefined`.

## Dynamic imports in callbacks

**Behavior**: `import()` expressions nested inside callbacks (e.g., `React.lazy(() => import("./Page"))`) are correctly handled.

**Why**: the dynamic import fix pass uses `getDescendantsOfKind(SyntaxKind.CallExpression)` which performs a full recursive AST walk, finding `import()` calls at any nesting depth.

**Limitation**: only string literal arguments are processed. Template literals like `` import(`./locales/${lang}`) `` are skipped because the specifier is not a `StringLiteral` AST node.

## Template literal imports

**Behavior**: skipped entirely. No rewriting is attempted.

**Example**:
```ts
const module = await import(`./plugins/${name}`);
```

The tool only processes `import()` calls where the first argument is a `StringLiteral`. Template literals, concatenated strings, and variable references are all ignored.

## require() calls

**Behavior**: fully handled. CommonJS `require()` calls are rewritten using the same logic as dynamic `import()`.

- Relative `require("./foo")` calls are rewritten when the target or the importing file moves.
- Alias `require("@/foo")` calls are rewritten based on the `useAliases` mode, just like static imports.
- Non-relative, non-alias `require("fs")` calls are left alone.
- The `.js` extension convention is preserved: if the project uses `.js` extensions in specifiers, `require()` specifiers will too.

## Files with syntax errors

**Behavior**: ts-morph can still parse and process files with certain syntax errors. The AST is constructed in a best-effort manner, and import declarations that are syntactically valid within the file will still be rewritten.

**Caveat**: severely malformed files may cause ts-morph to skip imports or produce unexpected AST structures.

## Empty directories

**Behavior**: automatically cleaned up after moves.

The cleanup walks upward from each source file's parent directory toward the project root. Empty directories are removed one at a time. If a directory still contains files, the upward walk stops.

**Safety**: the project root itself is never removed (the `current !== projectRoot` check).

## Symlinks

**Behavior**: skipped during directory expansion.

`findAllFiles()` and `findTsFiles()` use `entry.isFile()` from `fs.readdirSync({ withFileTypes: true })`. For symlinks, `isFile()` returns `false` (use `isSymbolicLink()` to detect them). As a result, symlinked files within a moved directory are silently skipped.

## Unicode filenames

**Behavior**: handled correctly.

All path operations use Node.js `path` and `fs` modules which support Unicode filenames natively. No special normalization is applied, so NFC vs NFD differences (common on macOS) could theoretically cause mismatches, but this has not been observed in practice.

## CRLF line endings

**Behavior**: ts-morph may normalize line endings when saving files. If a file uses CRLF (`\r\n`) line endings, they may be converted to LF (`\n`) after the file is saved by ts-morph.

**Scope**: only files that ts-morph modifies (moved files and files with rewritten imports) are affected. Untouched files remain as-is.

## Extension detection sampling limit

**Behavior**: the `.js` extension convention is detected by sampling up to 30 source files.

If a large project has inconsistent conventions and the first 30 files happen to not use `.js` extensions, the tool may incorrectly choose extensionless mode (or vice versa). The 50% threshold means a mixed codebase needs a clear majority to trigger `.js` mode.

**Mitigation**: keep your import style consistent across the project.

## Non-wildcard (exact) aliases

**Behavior**: fully supported.

Aliases like `"@config": ["./src/config.ts"]` (without `/*` suffix) are treated as exact matches. They only match the literal specifier `@config`, not `@config/sub`. Both resolution and re-aliasing work correctly for these mappings.

## Case-insensitive filesystems

**Behavior**: handled via a two-step rename through a temporary path.

On macOS (HFS+, APFS) and Windows (NTFS), renaming `Component.tsx` to `component.tsx` is a no-op at the filesystem level. The tool detects this case (`src.toLowerCase() === dest.toLowerCase() && src !== dest`) and:

1. Moves to `<dest>.__ts_mv_tmp__`
2. Moves from the temp path to the final destination.

The original file deletion step is skipped for case renames since the filesystem already considers them the same file.

## Overlapping source and destination paths

**Behavior**: handled via move ordering.

When file A's source is file B's destination and vice versa, the tool sorts moves so files whose source path is a destination of another move are processed first. The `overwrite` flag is set when the on-disk file has already been moved away in-memory.

## .d.ts files

**Behavior**: excluded from ts-morph project, but moved as regular files during directory moves.

`findTsFiles()` explicitly filters out `.d.ts` files (`!entry.name.endsWith(".d.ts")`). They are picked up by `findAllFiles()` during directory expansion and copied like non-TS files.

## Files outside tsconfig include

**Behavior**: not analyzed for import rewriting.

Only files matched by the `tsconfig.json` `include` pattern are loaded into the ts-morph project. If a file outside this scope imports a moved file, its imports will not be updated.

## Index file resolution

**Behavior**: `index.ts` and `index.tsx` are resolved as candidates when an import specifier points to a directory.

When computing new import paths, `/index` suffixes are stripped from specifiers (e.g., `./utils/index` becomes `./utils`) to maintain clean imports.

## /index stripping for dynamic imports and require()

**Behavior**: ts-morph v25+ may produce `import("./dir/index")` or `require("./dir/index")` (with or without `.js` extension) for calls that originally targeted a directory index file. ts-shove automatically strips the `/index` suffix so the specifier stays clean (e.g., `./dir` or `./dir.js`).

**Why**: ts-morph rewrites dynamic import specifiers in some versions but expands the directory shorthand to an explicit `/index` path. This pass normalizes those specifiers back to the directory form.
