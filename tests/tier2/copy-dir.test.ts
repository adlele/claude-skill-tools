import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { copyDirIfExists } from "../../src/shared/utils.js";
import { createTempDir, removeTempDir, writeFile } from "../helpers/fixtures.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(createTempDir("cst-copydir-"));
});

afterAll(() => {
  if (tmpDir) removeTempDir(tmpDir);
});

describe("copyDirIfExists", () => {
  it("silently skips when source does not exist", () => {
    const dest = path.join(tmpDir, "dest");
    expect(() => copyDirIfExists("/nonexistent/path", dest)).not.toThrow();
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("copies a single file", () => {
    const src = path.join(tmpDir, "src-file.txt");
    const dest = path.join(tmpDir, "dest-file.txt");
    fs.writeFileSync(src, "hello");
    copyDirIfExists(src, dest);
    expect(fs.readFileSync(dest, "utf-8")).toBe("hello");
  });

  it("recursively copies a directory", () => {
    const srcDir = path.join(tmpDir, "src-dir");
    writeFile(path.join(srcDir, "a.txt"), "aaa");
    writeFile(path.join(srcDir, "sub/b.txt"), "bbb");

    const destDir = path.join(tmpDir, "dest-dir");
    copyDirIfExists(srcDir, destDir);

    expect(fs.readFileSync(path.join(destDir, "a.txt"), "utf-8")).toBe("aaa");
    expect(fs.readFileSync(path.join(destDir, "sub/b.txt"), "utf-8")).toBe(
      "bbb",
    );
  });

  it("skips .state directories", () => {
    const srcDir = path.join(tmpDir, "src-state");
    writeFile(path.join(srcDir, "keep.txt"), "keep");
    writeFile(path.join(srcDir, ".state/secret.txt"), "skip");

    const destDir = path.join(tmpDir, "dest-state");
    copyDirIfExists(srcDir, destDir);

    expect(fs.existsSync(path.join(destDir, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, ".state"))).toBe(false);
  });

  it("creates destination parent directories as needed", () => {
    const src = path.join(tmpDir, "nested-src.txt");
    fs.writeFileSync(src, "data");
    const dest = path.join(tmpDir, "deep/nested/dest.txt");
    copyDirIfExists(src, dest);
    expect(fs.readFileSync(dest, "utf-8")).toBe("data");
  });
});
