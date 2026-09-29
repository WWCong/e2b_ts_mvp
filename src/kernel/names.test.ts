import { describe, expect, test } from "bun:test";
import { checkName, checkPackageName } from "./names";

describe("命名规则", () => {
  test("Operation 名是「包名_导出名」：包名小写字母、数字与 -，导出名字母与数字，最长 64", () => {
    for (const name of ["fs_read", "video-analysis_completionScore", "a1_b2"]) {
      expect(() => checkName(name)).not.toThrow();
    }
    for (const name of ["fs.read", "fs_read_all", "Fs_read", "fs_", "_read", "fs_read-all", `fs_${"a".repeat(62)}`]) {
      expect(() => checkName(name)).toThrow(`invalid name: ${name}`);
    }
  });

  test("包名：小写字母开头，只含小写字母、数字与 -", () => {
    expect(() => checkPackageName("video-analysis")).not.toThrow();
    for (const pkg of ["Video", "video_analysis", "1video"]) {
      expect(() => checkPackageName(pkg)).toThrow(`invalid package name: ${pkg}`);
    }
  });
});
