import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export function createTestHelpers(testDir: string) {
  function setupProject(files: Record<string, string>) {
    fs.rmSync(testDir, { recursive: true, force: true });

    for (const [filePath, content] of Object.entries(files)) {
      const abs = path.join(testDir, filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }

    // Write a local .gitignore that allows everything, overriding the parent
    // project's .gitignore which excludes .test/ and would block `git add .`
    fs.writeFileSync(path.join(testDir, ".gitignore"), "");
    execFileSync("git", ["init"], { cwd: testDir, stdio: "pipe" });
    execFileSync("git", ["add", "."], { cwd: testDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: testDir, stdio: "pipe" });
  }

  function setupProjectNoGit(files: Record<string, string>) {
    fs.rmSync(testDir, { recursive: true, force: true });

    for (const [filePath, content] of Object.entries(files)) {
      const abs = path.join(testDir, filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }

  function readFile(relativePath: string): string {
    return fs.readFileSync(path.join(testDir, relativePath), "utf-8");
  }

  function fileExists(relativePath: string): boolean {
    return fs.existsSync(path.join(testDir, relativePath));
  }

  /** Run tsc --noEmit on the test fixture to verify TypeScript AST integrity */
  function typecheck() {

    const tsConfigPath = path.join(testDir, "tsconfig.json");
    if (!fs.existsSync(tsConfigPath)) return;

    try {
      execFileSync(
        path.resolve(import.meta.dirname, "..", "node_modules", ".bin", "tsc"),
        ["--noEmit", "--pretty", "false"],
        { cwd: testDir, stdio: "pipe" },
      );
    } catch (err: unknown) {
      const execErr = err as { stderr?: Buffer; stdout?: Buffer };
      const stderr = execErr.stderr?.toString() ?? "";
      const stdout = execErr.stdout?.toString() ?? "";
      throw new Error(
        `TypeScript typecheck failed after move:\n${stdout}\n${stderr}`,
      );
    }
  }

  function cleanup() {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  return { setupProject, setupProjectNoGit, readFile, fileExists, typecheck, cleanup };
}
