# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2025-03-25

### Added

- CLI tool (`ts-shove`) for moving TypeScript files with automatic import rewriting
- Single file moves, directory moves, and batch moves via JSON manifest
- Static import rewriting via ts-morph AST analysis
- Dynamic `import()` expression rewriting
- `require()` call rewriting
- Side-effect import rewriting (`import "./foo"`)
- Re-export rewriting (`export { x } from`, `export * from`)
- `.js`/`.jsx` extension convention auto-detection and preservation
- tsconfig path alias support with three modes: `preserve`, `always`, `never`
- Wildcard (`@/*`) and exact-match alias support
- Non-TS file handling in directory moves (CSS, JSON, SVG, etc.)
- Git integration (stages moves as renames for clean history)
- Overwrite protection for all file types
- Empty directory cleanup after moves
- Case-sensitive rename support on case-insensitive filesystems (macOS)
- Batch move ordering for overlapping source/destination paths
- Dry-run mode with destination conflict detection
- Cross-project move validation
- Programmatic API (`executeMoves`) with TypeScript type declarations
