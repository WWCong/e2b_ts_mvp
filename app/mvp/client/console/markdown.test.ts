import { expect, test } from "bun:test";
import { terminalText } from "./markdown";

const answer = [
  "## 结果",
  "已写进 **summary.md**，用的是 `fs_write`：",
  "> 1. 周三开会",
  "- 详见 [文档](https://example.com/doc)",
  "```ts",
  "const a = 1;",
  "```",
].join("\n");

test("不是终端：只去掉 Markdown 的标记", () => {
  expect(terminalText(answer, false)).toBe(
    ["结果", "已写进 summary.md，用的是 fs_write：", "│ 1. 周三开会", "- 详见 文档（https://example.com/doc）", "  const a = 1;"].join("\n"),
  );
});

test("终端：标题与加粗是粗体，代码是青色", () => {
  const out = terminalText(answer, true).split("\n");
  expect(out[0]).toBe("\x1b[1m结果\x1b[22m");
  expect(out[1]).toBe("已写进 \x1b[1msummary.md\x1b[22m，用的是 \x1b[36mfs_write\x1b[39m：");
  expect(out[4]).toBe("  \x1b[36mconst a = 1;\x1b[39m");
});

test("没有 Markdown 的文字原样", () => {
  expect(terminalText("你好！我可以帮你查看文件。\n2 * 3 = 6", false)).toBe("你好！我可以帮你查看文件。\n2 * 3 = 6");
});
