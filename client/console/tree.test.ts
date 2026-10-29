import { expect, test } from "bun:test";
import type { HarnessEvent } from "stdlib";
import { eventTree } from "./tree";

test("spawn 起的树：根用 ⇢ 标出，缩进接着发起方；它结束的那行也标出", () => {
  const lines: string[] = [];
  const draw = eventTree((line) => lines.push(line));
  const event = (body: object) => draw({ boot: "b", seq: 0, ts: 0, ...body } as HarnessEvent);
  event({ type: "run.started", runId: "r1", operation: "demo_say", input: "hi", depth: 0, chain: [] });
  event({ type: "run.started", runId: "r2", operation: "demo_tidy", input: 3, depth: 1, chain: [], spawnedBy: "r1", step: 0 });
  event({ type: "run.spawned", runId: "r1", step: 0, target: "demo_tidy", input: 3, child: "r2" });
  event({ type: "run.exited", runId: "r1", operation: "demo_say", result: { ok: true, value: "好" } });
  event({ type: "run.exited", runId: "r2", operation: "demo_tidy", result: { ok: true, value: null } });

  expect(lines).toEqual(["▶ demo_say hi", "  ⇢ demo_tidy 3（另起一棵树）", "✓ demo_say → 好", "  ✓ demo_tidy → null（另起的树）"]);
});
