/**
 * script 包在解释器里跑（7.5）：QuickJS-NG 编译成 WASM（quickjs-wasi）。
 * - 底子：运行时与 Zod 求值一次、存成快照，每个进程一次
 * - 装载（compileScript）：恢复底子、求值包的代码、读出声明，交给内核的是声明与跑在解释器里的实现
 * - 一段源码（runSource，harness_exec 用）：打包，与包的 Operation 一样在全新的解释器里执行它的默认导出
 * - 包草稿（runDraft，harness_exec 用）：与装载一样打包、读出声明，在调用方的 Run 里执行其中一个 Operation
 * - 每个 Run：从底子恢复出一个全新的 WASM 实例（内存与别的 Run 不共享），求值包的代码，执行；结束或被杀即丢掉。
 *   实现发起的调用经 ctx.call 交给内核，记在这个 Run 名下，照常查能力面与公开表、记日志、恢复时回放
 * 限额：内存上限；一段同步执行（两次等待之间）超时即中断，这个 Run 以失败结束。
 * 宿主交给解释器的 JSON 按 UTF-8 字节传，在解释器里解码（encoding 扩展的 TextDecoder）：
 * quickjs-wasi 的 newString 对大字符串很慢（逐字查孤立代理项，5 MB 约 0.3 秒），历史里带图片时一次就是几 MB。
 */

import { QuickJS, type ExtensionDescriptor, type JSValueHandle, type Snapshot } from "quickjs-wasi";
import { z } from "zod";
import { basename } from "node:path";
import { SCRIPT_KEYS, type OpDecl, type ScriptObject } from "../kernel/plugin";
import type { LogLevel } from "../kernel/events";
import type { Ctx } from "../kernel/run";
import { bundleBase, bundlePackage, bundleSource } from "./bundle";

/** 每个解释器的内存上限 */
const MEMORY_LIMIT = 256 * 1024 * 1024;
/**
 * 一段同步执行的上限，缺省 1 秒。方案说几十毫秒（7.5）；这里宽一些，因为交进交出的 JSON 也在解释器里解析与生成，
 * 带图片的历史有几 MB，每 MB 约 10 毫秒
 */
const SLICE_MS = 1000;
/** 求值包的代码（建 schema 等）的上限 */
const LOAD_MS = 1000;
const encoder = new TextEncoder();

/** sliceMs：一段同步执行的上限；maxCalls：一次执行最多发起多少个调用，缺省不限 */
export type ScriptLimits = { sliceMs?: number; maxCalls?: number };
/** 宿主函数的名字：建底子时占好，恢复后接上 */
const HOST = ["__host_call", "__host_tools", "__host_log"] as const;

/** 包的声明：runtime.ts 的 declare 交出的 */
type Declaration = {
  keys: string[];
  requires?: string[];
  operations: (Pick<OpDecl, "usage" | "public" | "tool" | "api" | "only" | "exclude" | "decorators"> & {
    key: string;
    input: Record<string, unknown>;
    output?: Record<string, unknown>;
  })[];
};

type Base = { wasm: WebAssembly.Module; extensions: ExtensionDescriptor[]; snapshot: Snapshot };
let base: Promise<Base> | undefined;

/** 解释器的底子：编译好的 WASM、扩展与求值过运行时的快照 */
function getBase() {
  base ??= (async () => {
    const compile = (path: string) =>
      Bun.file(Bun.resolveSync(path, import.meta.dir))
        .bytes()
        .then((bytes) => WebAssembly.compile(bytes));
    const [wasm, encoding, code] = await Promise.all([compile("quickjs-wasi/quickjs.wasm"), compile("quickjs-wasi/encoding.so"), bundleBase()]);
    const extensions = [{ name: "encoding", wasm: encoding }];
    const vm = await QuickJS.create({ wasm, extensions });
    try {
      for (const name of HOST) {
        vm.newFunction(name, () => {
          throw new Error(`${name} is not connected`);
        }).consume((fn) => vm.setProp(vm.global, name, fn));
      }
      vm.evalCode(code, "harness-runtime.js").dispose();
      return { wasm, extensions, snapshot: vm.snapshot() };
    } finally {
      vm.dispose();
    }
  })();
  return base;
}

/** 装载 dir 下的 script 包：打包、在解释器里读出声明。包的代码不在宿主里执行 */
export async function compileScript(pkg: string, dir: string, limits: ScriptLimits = {}): Promise<ScriptObject> {
  let code: string;
  let decl: Declaration;
  try {
    [code, decl] = await declare(pkg, dir);
  } catch (err) {
    throw new Error(`${pkg}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const operations: Record<string, OpDecl> = {};
  for (const { key, input, output, ...rest } of decl.operations) {
    operations[key] = {
      ...rest,
      // 宿主按 JSON Schema 校验（方案：每次调用按 schema 校验入参）；对外与给模型的 schema 用包里生成的原样
      input: z.fromJSONSchema(input as never),
      output: output && z.fromJSONSchema(output as never),
      schemas: { input, output },
      source: code,
      impl: (ctx, input) => execute(pkg, code, key, input, ctx, limits),
    };
  }
  // 不认得的键照样交给内核，由它报错
  return { ...Object.fromEntries(decl.keys.map((key) => [key, undefined])), requires: decl.requires, operations };
}

/** 打包，在解释器里求值包的代码、读出声明 */
async function declare(pkg: string, dir: string): Promise<[code: string, decl: Declaration]> {
  const [code, { wasm, extensions, snapshot }] = await Promise.all([bundlePackage(dir), getBase()]);
  const deadline = performance.now() + LOAD_MS;
  const vm = await QuickJS.restore(snapshot, {
    wasm,
    extensions,
    memoryLimit: MEMORY_LIMIT,
    interruptHandler: () => performance.now() > deadline,
  });
  try {
    vm.evalCode(code, `${pkg}.js`).dispose();
    return [code, JSON.parse(vm.evalCode(`__harness.declare(${JSON.stringify(pkg)})`).consume((h) => h.toString()))];
  } finally {
    vm.dispose();
  }
}

/**
 * 在一个全新的解释器里跑一段源码：默认导出 async (ctx, input) => 结果。
 * 源码写错、import 了不许的，以异常报出，带行列
 */
export async function runSource(source: string, input: unknown, ctx: Ctx, limits: ScriptLimits = {}): Promise<unknown> {
  return execute("source", await bundleSource(source), null, input, ctx, limits);
}

/**
 * 跑 dir 下 script 包草稿的 Operation key：与装上的包一样打包、按它的 schema 校验入参与出参，在 ctx 的 Run 里执行。
 * 草稿没有装进内核：它的 requires、only、exclude 不起作用，调用记在 ctx 的 Run 名下
 */
export async function runDraft(dir: string, key: string, input: unknown, ctx: Ctx, limits: ScriptLimits = {}): Promise<unknown> {
  const pkg = basename(dir);
  const object = await compileScript(pkg, dir, limits);
  for (const k of Object.keys(object)) if (!SCRIPT_KEYS.has(k)) throw new Error(`${pkg}: unknown key in script object: ${k}`);
  const op = object.operations[key];
  if (!op) throw new Error(`${pkg} has no operation ${key} (it has: ${Object.keys(object.operations).join(", ") || "none"})`);
  const parsed = op.input.safeParse(input);
  if (!parsed.success) throw new Error(`invalid input for ${pkg}_${key}:\n${z.prettifyError(parsed.error)}`);
  const value = await op.impl(ctx, parsed.data);
  if (!op.output) return value;
  const checked = op.output.safeParse(value);
  if (!checked.success) throw new Error(`invalid output of ${pkg}_${key}:\n${z.prettifyError(checked.error)}`);
  return checked.data;
}

/** 在一个全新的解释器里执行包的一个 Operation；key 为 null 时执行默认导出的函数 */
async function execute(pkg: string, code: string, key: string | null, input: unknown, ctx: Ctx, limits: ScriptLimits): Promise<unknown> {
  const { sliceMs = SLICE_MS, maxCalls = Infinity } = limits;
  const { wasm, extensions, snapshot } = await getBase();
  let deadline = Infinity;
  let interrupted = false;
  const vm = await QuickJS.restore(snapshot, {
    wasm,
    extensions,
    memoryLimit: MEMORY_LIMIT,
    interruptHandler: () => (performance.now() > deadline ? (interrupted = true) : false),
  });

  const done = Promise.withResolvers<unknown>();
  /** 正在解释器里执行的层数：宿主函数是在解释器执行中被调的，那时不能丢掉解释器 */
  let busy = 0;
  let over = false;
  let disposed = false;
  const dispose = () => {
    if (busy > 0 || disposed) return;
    disposed = true;
    vm.dispose();
  };
  const end = (settle: () => void) => {
    if (over) return;
    over = true;
    settle();
    dispose();
  };
  const fail = (err: unknown) => end(() => done.reject(err));
  /** 交给解释器的值：JSON 的 UTF-8 字节 */
  const toGuest = (value: unknown) => vm.newUint8Array(encoder.encode(JSON.stringify(value)));

  /** 在解释器里执行一段，限时；超时、陷入（如递归太深）都让这个 Run 失败 */
  const slice = (ms: number, fn: () => void) => {
    if (over) return;
    deadline = performance.now() + ms;
    busy++;
    try {
      fn();
    } catch (err) {
      fail(interrupted ? new Error(`a synchronous stretch ran longer than ${ms} ms`) : err);
    } finally {
      busy--;
      deadline = Infinity;
      if (over) dispose();
    }
  };

  let calls = 0;
  vm.registerHostCallback("__host_call", (request) => {
    if (++calls > maxCalls) throw new Error(`more than ${maxCalls} calls`);
    const { name, input } = JSON.parse(request.toString()) as { name: string; input: unknown };
    const deferred = vm.newPromise();
    void ctx.call(name, input).then((result) =>
      slice(sliceMs, () => {
        toGuest(result).consume((value) => deferred.resolve(value));
        deferred.handle.dispose();
        vm.executePendingJobs();
      }),
    );
    return deferred.handle;
  });
  vm.registerHostCallback("__host_tools", () => vm.newString(JSON.stringify(ctx.tools())));
  vm.registerHostCallback("__host_log", (level, text) => {
    ctx.log(level.toString() as LogLevel, text.toString());
    return vm.undefined;
  });
  // 恢复的途中就被杀了：不再开始
  if (ctx.signal.aborted) fail(new Error("killed"));
  else ctx.signal.addEventListener("abort", () => fail(new Error("killed")), { once: true });

  slice(LOAD_MS, () => vm.evalCode(code, `${pkg}.js`).dispose());
  slice(sliceMs, () => {
    const request = { input, runId: ctx.runId, attempt: ctx.attempt, callerPackage: ctx.callerPackage };
    toGuest(request).consume((bytes) => vm.setProp(vm.global, "__request", bytes));
    const promise = vm.evalCode(`__harness.run(${JSON.stringify(key)}, __request)`);
    void vm.resolvePromise(promise).then((outcome) => {
      if (over) return;
      if ("error" in outcome) fail(toError(outcome.error));
      else end(() => done.resolve((JSON.parse(outcome.value.toString()) as { value?: unknown }).value));
    });
    promise.dispose();
    vm.executePendingJobs();
  });
  return done.promise;
}

/** 解释器里抛出的值转成宿主的 Error：只留原因 */
function toError(handle: JSValueHandle): Error {
  const value = handle.vm.dump(handle);
  return new Error(value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value));
}
