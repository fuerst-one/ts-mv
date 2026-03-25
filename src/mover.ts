import { Project, SyntaxKind, Identifier, type SourceFile } from "ts-morph";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { findAllFiles, findTsFiles, resolveCandidates } from "./resolver.js";

const CASE_RENAME_TEMP_SUFFIX = ".__ts_mv_tmp__";

export type AliasMode = "always" | "never" | "preserve";

export interface MoveManifest {
  projectRoot: string;
  moves: Record<string, string>;
  dryRun?: boolean;
  useAliases?: AliasMode;
  tsConfigPath?: string;
}

export interface MoveResult {
  filesMoved: number;
  importsRewritten: number;
  conflicts?: string[];
  warnings?: string[];
}

function expandMoves(
  moves: Record<string, string>,
  projectRoot: string,
): Map<string, string> {
  const expanded = new Map<string, string>();

  for (const [src, dest] of Object.entries(moves)) {
    const absSrc = path.resolve(projectRoot, src);
    const absDest = path.resolve(projectRoot, dest);

    if (!absSrc.startsWith(projectRoot + path.sep) && absSrc !== projectRoot) {
      throw new Error(`Source path is outside project root: ${src}`);
    }
    if (!absDest.startsWith(projectRoot + path.sep) && absDest !== projectRoot) {
      throw new Error(`Destination path is outside project root: ${dest}`);
    }

    if (src.endsWith("/")) {
      if (!fs.existsSync(absSrc)) {
        throw new Error(`Source directory does not exist: ${src}`);
      }
      for (const file of findAllFiles(absSrc)) {
        const relative = path.relative(absSrc, file);
        expanded.set(file, path.join(absDest, relative));
      }
    } else {
      if (!fs.existsSync(absSrc)) {
        throw new Error(`Source file does not exist: ${src}`);
      }
      expanded.set(absSrc, absDest);
    }
  }

  return expanded;
}

function detectJsExtensionConvention(project: Project): boolean {
  const sourceFiles = project.getSourceFiles().slice(0, 30);
  let jsExtCount = 0;
  let totalImports = 0;

  for (const sf of sourceFiles) {
    for (const decl of sf.getImportDeclarations()) {
      const specifier = decl.getModuleSpecifierValue();
      if (specifier.startsWith(".")) {
        totalImports++;
        if (/\.jsx?$/.test(specifier)) jsExtCount++;
      }
    }
  }

  return totalImports > 0 && jsExtCount / totalImports > 0.5;
}

/** Check if a call expression uses a module specifier as its first argument.
 *  Matches: import(), require(), vi.mock(), jest.mock(), and similar test utilities. */
function isModuleSpecifierCall(call: import("ts-morph").CallExpression): boolean {
  const expr = call.getExpression();
  // Dynamic import() — always a module specifier
  if (expr.getKind() === SyntaxKind.ImportKeyword) return true;
  // require() — always a module specifier
  if (expr.getKind() === SyntaxKind.Identifier && (expr as Identifier).getText() === "require") return true;
  // For any other call, check if the first arg looks like a relative module path
  const arg = getCallStringArg(call);
  if (!arg) return false;
  const val = arg.getLiteralValue();
  return val.startsWith("./") || val.startsWith("../");
}

function getCallStringArg(call: import("ts-morph").CallExpression): import("ts-morph").StringLiteral | null {
  const args = call.getArguments();
  if (args.length === 0) return null;
  const arg = args[0];
  if (arg.getKind() !== SyntaxKind.StringLiteral) return null;
  return arg.asKind(SyntaxKind.StringLiteral)!;
}

function isExplicitIndexImport(specifier: string): boolean {
  return /\/index$/.test(specifier) || specifier === "./index" || specifier === "../index";
}

function fixSpecifierExtension(
  literal: import("ts-morph").StringLiteral,
  sf: SourceFile,
  project: Project,
): void {
  const specifier = literal.getLiteralValue();
  if (!specifier.startsWith(".")) return;
  if (specifier.endsWith(".js") || specifier.endsWith(".jsx")) return;
  if (/\.[a-z]+$/i.test(specifier) && !/\.tsx?$/i.test(specifier)) return;

  const isExplicitIndex = isExplicitIndexImport(specifier);
  let fixedSpecifier = isExplicitIndex ? specifier : specifier.replace(/\/index$/, "");

  const dir = path.dirname(sf.getFilePath());
  const resolved = path.resolve(dir, fixedSpecifier);

  // Don't append .js to directory imports
  if (!isExplicitIndex) {
    const indexCandidates = [path.join(resolved, "index.ts"), path.join(resolved, "index.tsx")];
    if (indexCandidates.some((c) => project.getSourceFile(c))) return;
  }

  const tsxCandidates = [resolved + ".tsx", path.join(resolved, "index.tsx")];
  const isTsx = tsxCandidates.some((c) => project.getSourceFile(c));
  literal.setLiteralValue(fixedSpecifier + (isTsx ? ".jsx" : ".js"));
}

function buildRelativeSpecifier(
  fromFilePath: string,
  targetFilePath: string,
  usesJsExt: boolean,
): string {
  let rel = path.relative(path.dirname(fromFilePath), targetFilePath);
  if (!rel.startsWith(".")) rel = "./" + rel;
  rel = rel.replace(/\.tsx?$/, "");
  rel = rel.replace(/\/index$/, "");
  if (usesJsExt) rel += targetFilePath.endsWith(".tsx") ? ".jsx" : ".js";
  return rel;
}

/**
 * ts-morph's move() rewrites relative imports but strips .js extensions.
 * This pass restores them for projects that use .js in import specifiers.
 */
function fixJsExtensions(project: Project) {
  for (const sf of project.getSourceFiles()) {
    // Fix static import/export declarations
    const declarations = [
      ...sf.getImportDeclarations(),
      ...sf.getExportDeclarations().filter((d) => d.getModuleSpecifierValue()),
    ];

    for (const decl of declarations) {
      const specifier = decl.getModuleSpecifierValue();
      if (!specifier || !specifier.startsWith(".")) continue;
      if (specifier.endsWith(".js") || specifier.endsWith(".jsx")) continue;
      if (/\.[a-z]+$/i.test(specifier) && !/\.tsx?$/i.test(specifier)) continue;

      const resolved = decl.getModuleSpecifierSourceFile();
      // Directory imports (./atoms → ./atoms/index.ts) should not get .js appended
      // But explicit index imports (./index, ./store/index) should get .js
      if (resolved && /\/index\.tsx?$/.test(resolved.getFilePath()) && !isExplicitIndexImport(specifier)) continue;
      const ext = resolved && /\.tsx$/.test(resolved.getFilePath()) ? ".jsx" : ".js";
      decl.setModuleSpecifier(specifier + ext);
    }

    // Fix dynamic import() and require() call expressions
    sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((call) => {
      if (!isModuleSpecifierCall(call)) return;

      const literal = getCallStringArg(call);
      if (!literal) return;
      fixSpecifierExtension(literal, sf, project);
    });

    // Fix import() type expressions: const x: import("./types.js").Foo
    sf.getDescendantsOfKind(SyntaxKind.ImportType).forEach((importType) => {
      const argument = importType.getArgument();
      const literals = argument.getDescendantsOfKind(SyntaxKind.StringLiteral);
      if (literals.length === 0) return;
      const literal = literals[0];
      fixSpecifierExtension(literal, sf, project);
    });
  }
}

/**
 * Shared context for rewriting call-expression-based imports (import(), require()).
 * Built once per executeMoves, reused by fixDynamicImports and fixRequireCalls.
 */
function buildCallRewriteContext(moveMap: Map<string, string>, destPaths: Set<string>, aliasMappings?: AliasMapping[], useAliases?: AliasMode) {
  const reverseMap = new Map<string, string>();
  for (const [src, dest] of moveMap) {
    reverseMap.set(dest, src);
  }
  return { reverseMap, destPaths, aliasMappings, useAliases };
}

function rewriteCallSpecifier(
  literal: import("ts-morph").StringLiteral,
  filePath: string,
  originalFilePath: string,
  moveMap: Map<string, string>,
  destPaths: Set<string>,
  project: Project,
  usesJsExt: boolean,
  aliasMappings?: AliasMapping[],
  useAliases?: AliasMode,
): boolean {
  const specifier = literal.getLiteralValue();
  const isRelative = specifier.startsWith(".");

  let resolvedBase: string | null = null;

  if (isRelative) {
    const dir = path.dirname(originalFilePath);
    resolvedBase = path.resolve(dir, specifier).replace(/\.jsx?$/, "");
  } else if (aliasMappings && aliasMappings.length > 0) {
    // Try to resolve non-relative specifier through alias mappings
    resolvedBase = resolveAliasToAbsolute(specifier, aliasMappings);
  }

  if (!resolvedBase) return false;

  const candidates = resolveCandidates(resolvedBase);
  let targetPath: string | null = null;
  for (const c of candidates) {
    if (moveMap.has(c) || project.getSourceFile(c) || destPaths.has(c)) {
      targetPath = c;
      break;
    }
  }
  if (!targetPath) return false;

  const newTargetPath = moveMap.get(targetPath) ?? targetPath;
  // Only skip if target didn't move AND the file itself didn't move (specifier is still valid)
  if (newTargetPath === targetPath && filePath === originalFilePath) return false;

  // Determine the new specifier
  let newSpecifier: string | null = null;

  // Try alias first if mode is preserve (and original was alias) or always
  if (aliasMappings && aliasMappings.length > 0) {
    const mode = useAliases ?? "preserve";
    if (mode === "always" || (mode === "preserve" && !isRelative)) {
      newSpecifier = absolutePathToAlias(newTargetPath, aliasMappings, usesJsExt);
    }
  }

  // Fall back to relative path
  if (!newSpecifier) {
    newSpecifier = buildRelativeSpecifier(filePath, newTargetPath, usesJsExt);
  }

  if (newSpecifier !== specifier) {
    literal.setLiteralValue(newSpecifier);
    return true;
  }
  return false;
}

/**
 * Rewrites module specifiers in call expressions (import(), require(), vi.mock(), etc.)
 * when their targets have been moved.
 */
function fixCallExpressions(
  project: Project,
  moveMap: Map<string, string>,
  usesJsExt: boolean,
  ctx: ReturnType<typeof buildCallRewriteContext>,
) {
  let count = 0;

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    const originalFilePath = ctx.reverseMap.get(filePath) ?? filePath;

    sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((call) => {
      if (!isModuleSpecifierCall(call)) return;

      const literal = getCallStringArg(call);
      if (!literal) return;

      if (rewriteCallSpecifier(literal, filePath, originalFilePath, moveMap, ctx.destPaths, project, usesJsExt, ctx.aliasMappings, ctx.useAliases)) {
        count++;
      }
    });

    // Also handle import() type expressions: const x: import("./types").Foo
    sf.getDescendantsOfKind(SyntaxKind.ImportType).forEach((importType) => {
      const argument = importType.getArgument();
      const literals = argument.getDescendantsOfKind(SyntaxKind.StringLiteral);
      if (literals.length === 0) return;
      const literal = literals[0];

      if (rewriteCallSpecifier(literal, filePath, originalFilePath, moveMap, ctx.destPaths, project, usesJsExt, ctx.aliasMappings, ctx.useAliases)) {
        count++;
      }
    });
  }

  return count;
}

/**
 * ts-morph's move() doesn't update side-effect imports (import "./foo")
 * because they have no bindings. This pass fixes them manually.
 */
function fixSideEffectImports(
  project: Project,
  moveMap: Map<string, string>,
  usesJsExt: boolean,
) {
  let count = 0;

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();

    for (const decl of sf.getImportDeclarations()) {
      // Only target side-effect imports (no named/default/namespace bindings)
      if (decl.getNamedImports().length > 0) continue;
      if (decl.getDefaultImport()) continue;
      if (decl.getNamespaceImport()) continue;

      const specifier = decl.getModuleSpecifierValue();
      if (!specifier.startsWith(".")) continue;

      const dir = path.dirname(filePath);
      let resolved = path.resolve(dir, specifier).replace(/\.jsx?$/, "");

      const candidates = resolveCandidates(resolved);
      let targetPath: string | null = null;
      for (const c of candidates) {
        if (moveMap.has(c)) {
          targetPath = c;
          break;
        }
      }
      if (!targetPath) continue;

      const newTargetPath = moveMap.get(targetPath)!;
      if (newTargetPath === targetPath) continue;

      const newRel = buildRelativeSpecifier(filePath, newTargetPath, usesJsExt);

      if (newRel !== specifier) {
        decl.setModuleSpecifier(newRel);
        count++;
      }
    }
  }

  return count;
}

interface AliasMapping {
  prefix: string;
  baseDir: string;
  isExact?: boolean;
}

function parseAliasMappings(project: Project, projectRoot: string): AliasMapping[] {
  const compilerOptions = project.getCompilerOptions();
  const configPaths = compilerOptions.paths;
  if (!configPaths) return [];

  const baseUrl = compilerOptions.baseUrl ?? projectRoot;
  const mappings: AliasMapping[] = [];

  for (const [pattern, targets] of Object.entries(configPaths)) {
    if (targets.length === 0) continue;
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1); // "@/*" -> "@/"
      const target = targets[0];
      const base = target.endsWith("/*") ? target.slice(0, -2) : target;
      mappings.push({ prefix, baseDir: path.resolve(baseUrl, base) });
    } else {
      const target = targets[0];
      mappings.push({ prefix: pattern, baseDir: path.resolve(baseUrl, target), isExact: true });
    }
  }

  // Sort by baseDir length descending — most specific alias first
  return mappings.sort((a, b) => b.baseDir.length - a.baseDir.length);
}

function absolutePathToAlias(absPath: string, mappings: AliasMapping[], usesJsExt: boolean): string | null {
  for (const mapping of mappings) {
    if (mapping.isExact) {
      const target = mapping.baseDir.replace(/\.tsx?$/, "");
      const absNoExt = absPath.replace(/\.tsx?$/, "");
      if (absNoExt === target) {
        let specifier = mapping.prefix;
        if (usesJsExt) specifier += absPath.endsWith(".tsx") ? ".jsx" : ".js";
        return specifier;
      }
      continue;
    }
    const rel = path.relative(mapping.baseDir, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    let specifier = mapping.prefix + rel.replace(/\.tsx?$/, "");
    if (usesJsExt) specifier += absPath.endsWith(".tsx") ? ".jsx" : ".js";
    return specifier;
  }
  return null;
}

function resolveAliasToAbsolute(specifier: string, mappings: AliasMapping[]): string | null {
  // Strip .js/.jsx extension for resolution
  const bare = specifier.replace(/\.jsx?$/, "");
  for (const mapping of mappings) {
    if (mapping.isExact) {
      if (bare === mapping.prefix) {
        return mapping.baseDir.replace(/\.tsx?$/, "");
      }
      continue;
    }
    if (!bare.startsWith(mapping.prefix)) continue;
    const remainder = bare.slice(mapping.prefix.length);
    return path.resolve(mapping.baseDir, remainder);
  }
  return null;
}

/**
 * Handle alias imports based on the useAliases mode.
 * Only touches files involved in the move (moved files + their importers).
 */
function handleAliases(
  project: Project,
  moveMap: Map<string, string>,
  involvedFiles: Set<string>,
  projectRoot: string,
  usesJsExt: boolean,
  mode: AliasMode,
) {
  const mappings = parseAliasMappings(project, projectRoot);
  if (mappings.length === 0) return 0;

  let count = 0;

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (!involvedFiles.has(filePath)) continue;

    const declarations = [
      ...sf.getImportDeclarations(),
      ...sf.getExportDeclarations().filter((d) => d.getModuleSpecifierValue()),
    ];

    for (const decl of declarations) {
      const specifier = decl.getModuleSpecifierValue();
      if (!specifier) continue;

      const isAlias = !specifier.startsWith(".");

      if (isAlias) {
        if (mode === "never") {
          // Convert alias to relative path
          const resolved = resolveAliasToAbsolute(specifier, mappings);
          if (!resolved) continue;
          // Find the actual file
          const candidates = resolveCandidates(resolved);
          let targetFile: string | null = null;
          for (const c of candidates) {
            // Check if this file exists in the project (at its new location if moved)
            const newC = moveMap.get(c) ?? c;
            if (project.getSourceFile(newC)) {
              targetFile = newC;
              break;
            }
          }
          if (!targetFile) continue;

          const relPath = buildRelativeSpecifier(filePath, targetFile, usesJsExt);
          decl.setModuleSpecifier(relPath);
          count++;
        } else {
          // preserve or always: update alias if the target moved
          const resolved = resolveAliasToAbsolute(specifier, mappings);
          if (!resolved) continue;
          const candidates = resolveCandidates(resolved);
          for (const candidate of candidates) {
            const newPath = moveMap.get(candidate);
            if (!newPath) continue;

            // Try to re-alias the new path
            const newAlias = absolutePathToAlias(newPath, mappings, usesJsExt);
            if (newAlias) {
              decl.setModuleSpecifier(newAlias);
            } else {
              // Can't alias the new path — fall back to relative
              const relPath = buildRelativeSpecifier(filePath, newPath, usesJsExt);
              decl.setModuleSpecifier(relPath);
            }
            count++;
            break;
          }
        }
      } else if (!isAlias && mode === "always") {
        // Convert relative to alias
        const resolved = decl.getModuleSpecifierSourceFile();
        if (!resolved) continue;
        const targetPath = resolved.getFilePath();
        const alias = absolutePathToAlias(targetPath, mappings, usesJsExt);
        if (alias) {
          decl.setModuleSpecifier(alias);
          count++;
        }
      }
    }
  }

  return count;
}

function detectStaleReferences(
  moveMap: Map<string, string>,
  projectRoot: string,
): string[] {
  const warnings: string[] = [];

  // Build a set of old relative path stems (without extension) from moved files
  const movedStems = new Map<string, string>(); // old stem -> new dest relative path
  for (const [src, dest] of moveMap) {
    if (src === dest) continue;
    const relSrc = path.relative(projectRoot, src).replace(/\.tsx?$/, "");
    const relDest = path.relative(projectRoot, dest);
    movedStems.set(relSrc, relDest);
  }

  if (movedStems.size === 0) return warnings;

  // Scan all .ts/.tsx files for string literals containing old path references
  const allFiles = findTsFiles(projectRoot);
  for (const file of allFiles) {
    const content = fs.readFileSync(file, "utf-8");
    const relFile = path.relative(projectRoot, file);

    for (const [oldStem, newDest] of movedStems) {
      // Check for relative references to the old path from this file's perspective
      const fileDir = path.dirname(file);
      const oldAbs = path.resolve(projectRoot, oldStem);
      let oldRel = path.relative(fileDir, oldAbs);
      if (!oldRel.startsWith(".")) oldRel = "./" + oldRel;

      // Check for the old relative path (with various extensions) in string literals
      // but NOT in import/export declarations (those are already handled)
      const patterns = [oldRel, oldRel + ".js", oldRel + ".jsx"];
      for (const pattern of patterns) {
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip import/export "from" declarations — those are already rewritten by ts-morph
          if (line.match(/\bfrom\s+["']/) && line.match(/^\s*(import|export)\s/)) continue;
          // Skip static import declarations (import "foo" side-effect form)
          if (line.match(/^\s*import\s+["']/)) continue;
          // Check if the pattern appears inside quotes on this line
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const regex = new RegExp(`["']${escaped}["']`);
          if (regex.test(line)) {
            warnings.push(`${relFile}:${i + 1}: possible stale reference "${pattern}" (moved to ${newDest})`);
            break; // one warning per file per pattern
          }
        }
      }
    }
  }

  return warnings;
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function checkDryRunConflicts(
  moveMap: Map<string, string>,
  projectRoot: string,
): string[] {
  const conflicts: string[] = [];
  for (const [src, dest] of moveMap) {
    if (src === dest) continue;
    if (fs.existsSync(dest) && !moveMap.has(dest)) {
      conflicts.push(dest);
    }
  }
  if (conflicts.length > 0) {
    console.log(`\nConflicts detected: ${conflicts.length} destination(s) already exist`);
    for (const c of conflicts) {
      console.log(`  conflict: ${path.relative(projectRoot, c)}`);
    }
  }
  return conflicts;
}

function performTopologicalSort(
  moveEntries: Array<[string, string]>,
  destPaths: Set<string>,
): Array<[string, string]> {
  // Build a map from source -> index for dependency lookup
  const srcToIdx = new Map<string, number>();
  for (let i = 0; i < moveEntries.length; i++) {
    srcToIdx.set(moveEntries[i][0], i);
  }

  // Topological sort: a move X (src->dest) depends on move Y if Y.src === X.dest
  // (X must wait for Y to vacate dest). So Y must be processed before X.
  const sorted: Array<[string, string]> = [];
  const visited = new Set<number>();
  const visiting = new Set<number>();

  function visit(idx: number) {
    if (visited.has(idx)) return;
    if (visiting.has(idx)) return; // circular — break cycle
    visiting.add(idx);
    const [, dest] = moveEntries[idx];
    // If dest is another move's source, that move must go first
    const depIdx = srcToIdx.get(dest);
    if (depIdx !== undefined) {
      visit(depIdx);
    }
    visiting.delete(idx);
    visited.add(idx);
    sorted.push(moveEntries[idx]);
  }

  for (let i = 0; i < moveEntries.length; i++) {
    visit(i);
  }

  return sorted;
}

function stripIntroducedIndexSuffixes(
  project: Project,
  preMoveCallSpecifiers: Map<string, Set<string>>,
  moveMap: Map<string, string>,
): void {
  const reverseForIndex = new Map<string, string>();
  for (const [src, dest] of moveMap) reverseForIndex.set(dest, src);

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    const originalPath = reverseForIndex.get(filePath) ?? filePath;
    const originalSpecs = preMoveCallSpecifiers.get(originalPath);

    sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((call) => {
      if (!isModuleSpecifierCall(call)) return;
      const literal = getCallStringArg(call);
      if (!literal) return;
      const val = literal.getLiteralValue();
      if (!(val.endsWith("/index") || val.endsWith("/index.js") || val.endsWith("/index.jsx"))) return;

      // Check if the original code already had a /index specifier at this position
      // If so, don't strip it — the user wrote it intentionally
      if (originalSpecs) {
        const stripped = val.replace(/\/index(\.jsx?)?$/, "$1");
        // If the original had the /index version, preserve it
        if (originalSpecs.has(val)) return;
        // If the original had the stripped version (no /index), then ts-morph introduced /index — strip it
        if (originalSpecs.has(stripped) || !originalSpecs.has(val)) {
          literal.setLiteralValue(stripped);
        }
      }
    });
  }
}

function collectInvolvedFiles(
  project: Project,
  moveMap: Map<string, string>,
  aliasMappings: AliasMapping[],
  isTsFile: (f: string) => boolean,
): Set<string> {
  const involvedFiles = new Set<string>();
  // All destination files are involved
  for (const dest of moveMap.values()) {
    if (isTsFile(dest)) involvedFiles.add(dest);
  }
  // Any file that imports a moved file (via relative path or alias) is involved
  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (involvedFiles.has(filePath)) continue;

    let isInvolved = false;
    const allDecls = [
      ...sf.getImportDeclarations(),
      ...sf.getExportDeclarations().filter((d) => d.getModuleSpecifierValue()),
    ];

    for (const decl of allDecls) {
      // Check relative imports resolved by ts-morph
      const target = decl.getModuleSpecifierSourceFile();
      if (target && involvedFiles.has(target.getFilePath())) {
        isInvolved = true;
        break;
      }

      // Check alias imports that may point to moved files
      const specifier = decl.getModuleSpecifierValue();
      if (specifier && !specifier.startsWith(".") && aliasMappings.length > 0) {
        const resolved = resolveAliasToAbsolute(specifier, aliasMappings);
        if (resolved) {
          const candidates = resolveCandidates(resolved);
          if (candidates.some((c) => moveMap.has(c))) {
            isInvolved = true;
            break;
          }
        }
      }
    }

    if (isInvolved) involvedFiles.add(filePath);
  }

  return involvedFiles;
}

function commitMovesToDisk(
  moveMap: Map<string, string>,
  projectRoot: string,
  isTsFile: (f: string) => boolean,
  destPaths: Set<string>,
): number {
  let movedCount = 0;

  // Copy non-TS files (not managed by ts-morph)
  for (const [src, dest] of moveMap) {
    if (isTsFile(src)) continue;
    if (src === dest) continue;
    const destDir = path.dirname(dest);
    fs.mkdirSync(destDir, { recursive: true });
    if (fs.existsSync(dest)) {
      throw new Error(`Destination file already exists: ${dest}`);
    }
    fs.copyFileSync(src, dest);
    movedCount++;
  }

  // Delete original files (ts-morph creates new files but doesn't delete originals)
  const useGit = isGitRepo(projectRoot);
  for (const [src, dest] of moveMap) {
    if (src === dest) continue;
    const isCaseRename = src.toLowerCase() === dest.toLowerCase();
    if (isCaseRename) continue;
    // Skip deletion if this source path is also a destination of another move
    if (destPaths.has(src)) continue;
    if (fs.existsSync(src)) {
      if (useGit) {
        // Stage the move as a rename for clean git history
        try {
          execFileSync("git", ["add", dest], { cwd: projectRoot, stdio: "pipe" });
          execFileSync("git", ["rm", "--quiet", src], { cwd: projectRoot, stdio: "pipe" });
        } catch {
          fs.unlinkSync(src);
        }
      } else {
        fs.unlinkSync(src);
      }
    }
  }

  return movedCount;
}

function cleanEmptyDirectories(
  moveMap: Map<string, string>,
  projectRoot: string,
): void {
  const dirsToCheck = new Set<string>();
  for (const [src] of moveMap) {
    dirsToCheck.add(path.dirname(src));
  }

  for (const dir of [...dirsToCheck].sort((a, b) => b.length - a.length)) {
    let current = dir;
    while (current !== projectRoot && current.startsWith(projectRoot)) {
      try {
        const entries = fs.readdirSync(current);
        if (entries.length === 0) {
          fs.rmdirSync(current);
          console.log(`  removed empty dir: ${path.relative(projectRoot, current)}/`);
        } else {
          break;
        }
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }
}

export function executeMoves(manifest: MoveManifest): MoveResult {
  const { projectRoot, dryRun = false, useAliases = "preserve" } = manifest;

  // Load full project so ts-morph can rewrite all importers
  const tsConfigPath = manifest.tsConfigPath
    ? path.resolve(projectRoot, manifest.tsConfigPath)
    : path.join(projectRoot, "tsconfig.json");
  if (!fs.existsSync(tsConfigPath)) {
    throw new Error(`No tsconfig.json found at ${tsConfigPath}`);
  }

  const moveMap = expandMoves(manifest.moves, projectRoot);

  console.log(`Project: ${projectRoot}`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`\n${moveMap.size} file(s) to move:\n`);

  for (const [src, dest] of moveMap) {
    console.log(`  ${path.relative(projectRoot, src)} -> ${path.relative(projectRoot, dest)}`);
  }

  const project = new Project({ tsConfigFilePath: tsConfigPath });

  // Validate that all TS move sources are in the ts-morph project.
  // If a file is excluded from tsconfig (e.g., test files), throw early
  // so the user knows to either include it in tsconfig or use a broader tsconfig.
  const isTsFile = (f: string) => /\.tsx?$/.test(f);
  for (const [src] of moveMap) {
    if (!isTsFile(src)) continue;
    if (!project.getSourceFile(src)) {
      throw new Error(
        `Source file is not included in tsconfig: ${path.relative(projectRoot, src)}\n` +
        `ts-morph cannot rewrite imports for files outside the project.\n` +
        `Either add it to tsconfig "include" or use --tsconfig to specify a broader config.`,
      );
    }
  }

  const usesJsExt = detectJsExtensionConvention(project);
  console.log(`\nImport convention: ${usesJsExt ? ".js extensions" : "extensionless"}`);

  // Build destPaths once, reuse everywhere
  const destPaths = new Set(moveMap.values());

  if (dryRun) {
    const conflicts = checkDryRunConflicts(moveMap, projectRoot);
    console.log("\nDry run — no changes written.");
    return { filesMoved: 0, importsRewritten: 0, conflicts: conflicts.length > 0 ? conflicts : undefined };
  }

  // Step 1: Move all TS files in-memory (ts-morph rewrites relative imports automatically)
  let movedCount = 0;

  // Topological sort: process moves in reverse chain order so that a move whose
  // destination is another move's source is processed AFTER that other move.
  const filteredEntries = [...moveMap.entries()].filter(([src, dest]) => src !== dest && isTsFile(src));
  const moveEntries = performTopologicalSort(filteredEntries, destPaths);

  // Record dynamic import/require specifiers BEFORE moves so we can tell
  // which /index suffixes were original vs introduced by ts-morph
  const preMoveCallSpecifiers = new Map<string, Set<string>>();
  for (const sf of project.getSourceFiles()) {
    const specs = new Set<string>();
    sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((call) => {
      if (!isModuleSpecifierCall(call)) return;
      const literal = getCallStringArg(call);
      if (!literal) return;
      specs.add(literal.getLiteralValue());
    });
    if (specs.size > 0) preMoveCallSpecifiers.set(sf.getFilePath(), specs);
  }

  const movedSources = new Set<string>();
  for (const [src, dest] of moveEntries) {
    const sourceFile = project.getSourceFile(src);
    if (!sourceFile) {
      console.warn(`  warning: ${path.relative(projectRoot, src)} not found in project, skipping`);
      continue;
    }

    const destDir = path.dirname(dest);
    fs.mkdirSync(destDir, { recursive: true });

    const isCaseRename = src.toLowerCase() === dest.toLowerCase() && src !== dest;
    if (isCaseRename) {
      // Two-step move for case-only renames on case-insensitive filesystems:
      // ts-morph sees the paths as identical, so move to a temp path first.
      const tempDest = dest + CASE_RENAME_TEMP_SUFFIX;
      sourceFile.move(tempDest, { overwrite: true });
      const tempFile = project.getSourceFile(tempDest)!;
      tempFile.move(dest, { overwrite: true });
    } else {
      // If dest still exists on disk from a prior source that was already moved away
      // in-memory, we need overwrite to avoid ts-morph's file-exists check.
      const destExistsOnDisk = fs.existsSync(dest);
      const destMovedAway = movedSources.has(dest);
      const needsOverwrite = destExistsOnDisk && destMovedAway;
      sourceFile.move(dest, { overwrite: needsOverwrite });
    }
    movedSources.add(src);
    movedCount++;
  }

  console.log(`\nMoved ${movedCount} TS file(s) in-memory`);

  // Count ts-morph static import rewrites: files modified by ts-morph that aren't the moved files themselves
  const tsMorphRewriteCount = project.getSourceFiles().filter((sf) => {
    const fp = sf.getFilePath();
    return !sf.isSaved() && !destPaths.has(fp);
  }).length;

  // Step 2: Fix .js extensions if the project uses them (ts-morph strips them)
  if (usesJsExt) {
    console.log("Restoring .js import extensions...");
    fixJsExtensions(project);
  }

  // Step 2b: Strip /index from dynamic import() and require() specifiers
  // ts-morph v25+ rewrites dynamic imports but may produce ./dir/index instead of ./dir
  // Only strip /index that was INTRODUCED by ts-morph, not already present in original code
  stripIntroducedIndexSuffixes(project, preMoveCallSpecifiers, moveMap);

  // Parse alias mappings early — needed by both call rewriting and alias handling
  const aliasMappings = parseAliasMappings(project, projectRoot);

  // Step 3: Fix dynamic imports and require() calls (ts-morph doesn't handle these)
  const callCtx = buildCallRewriteContext(moveMap, destPaths, aliasMappings, useAliases);
  const callExprFixCount = fixCallExpressions(project, moveMap, usesJsExt, callCtx);
  if (callExprFixCount > 0) {
    console.log(`Fixed ${callExprFixCount} dynamic import(s) and require() call(s)`);
  }

  // Step 3b: Fix side-effect imports (ts-morph doesn't update imports with no bindings)
  const sideEffectFixCount = fixSideEffectImports(project, moveMap, usesJsExt);
  if (sideEffectFixCount > 0) {
    console.log(`Fixed ${sideEffectFixCount} side-effect import(s)`);
  }

  // Step 3c: Handle alias imports based on useAliases mode
  const involvedFiles = collectInvolvedFiles(project, moveMap, aliasMappings, isTsFile);

  const aliasFixCount = handleAliases(project, moveMap, involvedFiles, projectRoot, usesJsExt, useAliases);
  if (aliasFixCount > 0) {
    console.log(`Fixed ${aliasFixCount} alias import(s)`);
  }

  // Step 4: Write everything to disk in one shot
  console.log("Writing to disk...");
  project.saveSync();

  // Step 4a: Detect stale path references (before cleanup so files are on disk)
  const staleWarnings = detectStaleReferences(moveMap, projectRoot);
  if (staleWarnings.length > 0) {
    console.log(`\nWarnings: ${staleWarnings.length} possible stale reference(s) found:`);
    for (const w of staleWarnings) {
      console.log(`  ${w}`);
    }
  }

  // Step 4b: Copy non-TS files and delete originals via git
  const nonTsMovedCount = commitMovesToDisk(moveMap, projectRoot, isTsFile, destPaths);
  movedCount += nonTsMovedCount;

  // Step 6: Clean up empty directories
  cleanEmptyDirectories(moveMap, projectRoot);

  console.log("\nDone! Run `npx tsc --noEmit` to verify.");
  const totalRewrites = tsMorphRewriteCount + callExprFixCount + sideEffectFixCount + aliasFixCount;
  return {
    filesMoved: movedCount,
    importsRewritten: totalRewrites,
    warnings: staleWarnings.length > 0 ? staleWarnings : undefined,
  };
}
