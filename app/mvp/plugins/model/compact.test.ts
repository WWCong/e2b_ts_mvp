import { expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { estimateTokens, splitAt, withSummary } from "./compact";

const user = (content: string): Message => ({ role: "user", content, timestamp: 0 });

test("estimateTokens：中日韩等宽字符一个算一个，其余四个字符算一个（前缀「用户：」也算）", () => {
  expect(estimateTokens([user("你好")])).toBe(5);
  expect(estimateTokens([user("abcdefgh")])).toBe(3 + 2);
  expect(estimateTokens([user("你好"), user("abcd")])).toBe(5 + 4);
});

test("splitAt：保留最近 keep 轮，返回保留部分的起点；轮数不超过 keep 时返回 0", () => {
  const history = [user("1"), user("2"), user("3")];
  expect(splitAt(history, 1)).toBe(2);
  expect(splitAt(history, 2)).toBe(1);
  expect(splitAt(history, 3)).toBe(0);
});

test("withSummary：内容是分段的也能并进去，放在原话前面", () => {
  const first = { role: "user" as const, content: [{ type: "text" as const, text: "原话" }], timestamp: 1 };
  expect(withSummary("摘要", first)).toEqual({
    role: "user",
    content: [{ type: "text", text: "[之前对话的摘要]\n摘要\n\n[接着对话]\n" }, { type: "text", text: "原话" }],
    timestamp: 1,
  });
});
