# Bug: `vi.mock()` / `jest.mock()` calls detected but not auto-rewritten

**Discovered:** 2026-03-25, build-manager restructuring Tasks 1 & 3
**Severity:** Medium — requires manual cleanup after every move

## Current behavior

ts-shove detects stale `vi.mock("./old-path")` references after moves and prints warnings like:
```
⚠ Possible stale reference in src/runner/sync.test.ts: vi.mock("../git.js")
```

But it does NOT rewrite them. The user must manually update every `vi.mock()` / `jest.mock()` call.

## Expected behavior

`vi.mock()` and `jest.mock()` string arguments should be rewritten the same way `import()` and `require()` calls are. They use identical path resolution semantics — a string specifier relative to the file.

## Why it matters

In a typical restructuring, every moved file that has test coverage generates 1-5 stale `vi.mock()` calls. Across 15 tasks with 50+ test files, this adds up to hundreds of manual fixes.

## Suggested fix

In `fixCallExpressions()`, the current check is:
```typescript
const isDynamicImport = expr.getKind() === SyntaxKind.ImportKeyword;
const isRequire = expr.getKind() === SyntaxKind.Identifier && (expr as Identifier).getText() === "require";
if (!isDynamicImport && !isRequire) return;
```

Extend to also match `vi.mock`, `vi.doMock`, `jest.mock`, `jest.doMock`:
```typescript
const isTestMock = expr.getKind() === SyntaxKind.PropertyAccessExpression
  && /^(vi|jest)\.(mock|doMock|unmock|doUnmock)$/.test(expr.getText());
```

Then apply the same `rewriteCallSpecifier()` logic. The path resolution is identical — these are module specifiers resolved relative to the test file.

## Workaround

After running ts-shove, grep for the warnings and fix manually:
```bash
grep -rn 'vi\.mock\|jest\.mock' src/**/*.test.ts
```
