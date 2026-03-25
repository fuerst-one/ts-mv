# Bug: Directory imports get `.js` appended instead of `/index.js`

**Discovered:** 2026-03-25, build-manager restructuring Task 3
**Severity:** High — breaks builds silently

## Reproduction

Given a file that imports a directory via its index:
```typescript
// src/ui/components/Foo.tsx
import { Button } from './atoms';  // resolves to ./atoms/index.ts
```

After moving files that cause ts-mv to touch this import, the specifier becomes:
```typescript
import { Button } from './atoms.js';  // WRONG — should be './atoms/index.js' or './atoms'
```

This happens because the `.js` extension restoration pass (`fixJsExtensions`) appends `.js` to any relative import that lacks an extension, without checking whether the specifier resolves to a directory index file.

## Expected behavior

- If the original import was `./atoms` (directory import), it should stay as `./atoms` or become `./atoms/index.js` — never `./atoms.js`
- The fix should check: does this specifier resolve to `<dir>/index.ts`? If so, either leave it extensionless or append `/index.js`

## Affected code

`src/mover.ts`, `fixJsExtensions()` function — the logic that appends `.js` to extensionless relative imports needs a directory-index check.

## Scope

Affected 18 UI component files in the build-manager restructuring. All had `./atoms` directory imports that became `./atoms.js`.

## Suggested fix

In `fixJsExtensions()`, before appending `.js`, check if the resolved path is a directory with an index file:

```typescript
const dir = path.dirname(sf.getFilePath());
const resolved = path.resolve(dir, specifier);
// If it resolves to a directory index, don't append .js
const isDirectoryImport = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
if (isDirectoryImport) {
  // Either leave as-is or append /index.js
  continue;
}
```
