import { expect, test } from "bun:test";
import { parse } from "./prompt";

const choice = { question: "用哪种格式？", options: ["md", "txt", "第三种做法"] };

test("有选项：写序号或原样写选项都算选中，后面空格接补充说明；其余当作自己写的回答", () => {
  expect(parse(choice, "2")).toEqual({ option: "txt" });
  expect(parse(choice, "1 标题用日期")).toEqual({ option: "md", text: "标题用日期" });
  expect(parse(choice, "第三种做法")).toEqual({ option: "第三种做法" });
  expect(parse(choice, "TXT  标题用日期")).toEqual({ option: "txt", text: "标题用日期" });
  expect(parse({ question: "?", options: ["a", "a b"] }, "a b 说明")).toEqual({ option: "a b", text: "说明" });
  // 序号后没有空白、或序号越界：不当作选择
  expect(parse(choice, "2点开会")).toEqual({ text: "2点开会" });
  expect(parse(choice, "md格式")).toEqual({ text: "md格式" });
  expect(parse(choice, "4")).toEqual({ text: "4" });
  expect(parse(choice, "都不要，用 pdf")).toEqual({ text: "都不要，用 pdf" });
});

test("没有选项：整行就是回答", () => {
  expect(parse({ question: "文件名？" }, "1 summary.md")).toEqual({ text: "1 summary.md" });
});

test("/skip [原因]：不回答（撤回）；空行不算回答", () => {
  expect(parse(choice, "/skip")).toEqual({ skip: "用户不回答" });
  expect(parse(choice, "/skip 你自己决定")).toEqual({ skip: "用户不回答：你自己决定" });
  expect(parse(choice, "")).toBeUndefined();
});
