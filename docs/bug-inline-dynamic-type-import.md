# Bug: Inline dynamic type imports lose `.js` extension

**Discovered:** 2026-03-25, build-manager restructuring Task 3
**Severity:** Medium — breaks typecheck

## Reproduction

Given a file with an inline dynamic type import:
```typescript
// src/storage/hydration.ts
const ref: import("../types.js").TaskRef = ...;
```

After ts-mv rewrites imports in this file, the static `import ... from "../types.js"` declarations are correctly preserved with `.js`, but the inline `import("../types.js")` in the type position has its `.js` extension stripped:

```typescript
const ref: import("../types").TaskRef = ...;  // WRONG — lost .js
```

## Root cause

The `fixJsExtensions()` pass handles:
- Static import/export declarations ✅
- Dynamic `import()` call expressions ✅
- But NOT `import()` in **type positions** (TypeScript `import("...")` type syntax) ❌

TypeScript's `import("...")` type syntax uses `SyntaxKind.ImportType`, not `SyntaxKind.CallExpression`. The current code only looks for `CallExpression` with `ImportKeyword`.

## Expected behavior

Inline type imports like `import("../types.js").TaskRef` should have their `.js` extension preserved (or restored if stripped by ts-morph).

## Suggested fix

In `fixJsExtensions()`, add a pass for `ImportType` nodes:

```typescript
// Fix import() type expressions: import("./foo").Bar
sf.getDescendantsOfKind(SyntaxKind.ImportType).forEach((importType) => {
  const arg = importType.getArgument();
  // arg is a LiteralTypeNode containing a StringLiteral
  const literal = arg.getDescendantsOfKind(SyntaxKind.StringLiteral)[0];
  if (!literal) return;
  const specifier = literal.getLiteralValue();
  if (!specifier.startsWith(".")) return;
  if (specifier.endsWith(".js") || specifier.endsWith(".jsx")) return;
  // ... same extension restoration logic
});
```

Also apply to `fixCallExpressions()` / `rewriteCallSpecifier()` for path rewriting after moves.
