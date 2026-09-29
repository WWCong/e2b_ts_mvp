/**
 * 事件流（9.1、9.2、R25）：内核在每个状态转换点产生结构化事件，
 * 按顺序交给所有订阅者；投递去向由插件决定，内核从不读回。
 */
import type {
  Form,
  Json,
  JsonSchema,
  KernelLimits,
  KillReason,
  Limits,
  OperationName,
  Outcome,
  Rejection,
  RunId,
  SpawnOrigin,
} from "./types.ts";
import { snapshot } from "./json.ts";

// ─── 目录 ────────────────────────────────────────────────────────────────

/** 关键：至少一次投递；观测：尽力而为；流式：只走实时通道，不入日志 */
export type EventLevel = "critical" | "observe" | "stream";

/** 发起一次子调用的位置 */
export interface CallerRef {
  runId: RunId;
  /** 发起方调用记录里的序号 */
  seq: number;
  /** 由哪个装饰器发起；缺省为 Operation 本体 */
  decorator?: string;
  /** 仅 script：触发它的那次子调用的 seq */
  after?: number;
}

/**
 * 装饰器链上一环的处置：
 * - pass：调了 next，入参与结果都没改
 * - rewrite：改了入参或结果，或不调 next 直接给出成功结果
 * - reject：自己返回了拒绝
 * - skip：抛错且 `@onError open`，跳过这一环
 * - fail：抛错且 `@onError closed`，Run 以拒绝结束
 *
 * 挂起不单列：装饰器调 `harness.park` 由 `park.*` 事件记录（其 caller.decorator 为该装饰器），
 * 等到的值决定最终是 pass 还是 reject。
 */
export type Disposition = "pass" | "rewrite" | "reject" | "skip" | "fail";

export type ParkClosed =
  | { how: "unpark"; value: Json }
  | { how: "withdraw"; reason: string }
  | { how: "killed" };

export interface EventDataMap {
  "harness.started": {
    /** 产物摘要 */
    bundle: string;
    packages: { name: string; version: string; form: Form }[];
    /** 默认装饰器集，外 → 内 */
    defaultDecorators: string[];
    disabled: OperationName[];
    kernel: KernelLimits;
  };
  /** 开始关停（9.2）；关停的责任链挂点叫 `harness.stopping`，这里避开同名 */
  "harness.shutdown": { reason: string };

  /** [*] → init：带上 Run 出生时解析出的全部配置 */
  "run.created": {
    form: Form;
    input: Json;
    depth: number;
    /** 生效的能力面 */
    operations: OperationName[];
    /** 链序，外 → 内 */
    decorators: string[];
    limits: Limits;
    /** 子调用的发起位置；外部调用与新树的根为空 */
    caller?: CallerRef;
    /** 新树的根才有 */
    spawnedBy?: SpawnOrigin;
  };
  /** init → running：进入装饰器链 */
  "run.started": Record<string, never>;
  /** running → waiting */
  "run.waiting": { on: "children" | "park" };
  /** waiting → running */
  "run.resumed": Record<string, never>;
  /** running → exited */
  "run.exited": { outcome: Outcome; durationMs: number };
  /** → killed */
  "run.killed": { reason: KillReason };
  /** 模型增量输出 */
  "run.delta": { delta: Json };

  /** 内核在建 Run 之前就拒绝的调用：不可见、不在能力面、保险丝、入参不合 schema、没有当前 Run */
  "call.rejected": {
    target: OperationName;
    input: Json;
    caller?: CallerRef;
    rejection: Rejection;
  };

  "chain.step": {
    decorator: string;
    /** 链上位置，0 为最外层 */
    index: number;
    disposition: Disposition;
    /** 仅 rewrite */
    rewrote?: { input: boolean; result: boolean };
    /** 仅 skip / fail */
    error?: string;
  };

  /** runId 即 park id */
  "park.opened": { schema: JsonSchema; payload: Json };
  "park.closed": ParkClosed;

  /** 脚本与插件用 `emit(name, data)` 写的自定义事件 */
  emit: { name: string; data: Json };
}

export type EventType = keyof EventDataMap;

const DEFAULT_LEVELS: Readonly<Record<EventType, EventLevel>> = Object.freeze({
  "harness.started": "critical",
  "harness.shutdown": "critical",
  "run.created": "critical",
  "run.started": "critical",
  "run.waiting": "critical",
  "run.resumed": "critical",
  "run.exited": "critical",
  "run.killed": "critical",
  "run.delta": "stream",
  "call.rejected": "critical",
  "chain.step": "critical",
  "park.opened": "critical",
  "park.closed": "critical",
  emit: "observe",
});

/** 全部事件类型；每一种都是一个通知挂点（5.1） */
export const EVENT_TYPES: readonly EventType[] = Object.freeze(Object.keys(DEFAULT_LEVELS) as EventType[]);

/** 级别由目录决定，发出方不能改：链上只有拒绝与改写是关键级，放行是观测级（9.2） */
export function levelOf<T extends EventType>(type: T, data: EventDataMap[T]): EventLevel {
  if (type === "chain.step" && (data as EventDataMap["chain.step"]).disposition === "pass") {
    return "observe";
  }
  return DEFAULT_LEVELS[type];
}

/**
 * 一条事件。冗余自足：单看一条就是完整事实。
 * Run 是 span，runId / parentId / rootId 对应 span / parent span / trace。
 */
export interface HarnessEvent<T extends EventType = EventType> {
  /** 单调序号，从 1 开始 */
  readonly seq: number;
  /** 墙钟毫秒 */
  readonly ts: number;
  readonly type: T;
  readonly level: EventLevel;
  readonly runId?: RunId;
  readonly rootId?: RunId;
  readonly parentId?: RunId;
  readonly operation?: OperationName;
  /** 发出那一刻的深拷贝，已冻结 */
  readonly data: EventDataMap[T];
}

/** 按 type 可收窄的事件联合 */
export type AnyEvent = { [T in EventType]: HarnessEvent<T> }[EventType];

// ─── 总线 ────────────────────────────────────────────────────────────────

/** 事件关联的 Run */
export interface RunRef {
  runId: RunId;
  rootId: RunId;
  parentId?: RunId | null;
  operation: OperationName;
}

/**
 * 订阅者同步接收事件。要做慢事（投递、落盘）自己缓冲；
 * 返回 Promise 也不会被等待，只捕获它的失败。
 */
export type Subscriber = (event: AnyEvent) => void | Promise<void>;

export interface SubscribeFilter {
  levels?: readonly EventLevel[];
  types?: readonly EventType[];
}

export interface EventBusOptions {
  now?: () => number;
  /** 订阅者抛错或其 Promise 失败时调用；缺省写 stderr。事件流照常继续 */
  onSubscriberError?: (error: unknown, event: AnyEvent) => void;
}

interface Subscription {
  fn: Subscriber;
  filter: SubscribeFilter | undefined;
  active: boolean;
}

export class EventBus {
  #seq = 0;
  #subs: Subscription[] = [];
  #queue: AnyEvent[] = [];
  #delivering = false;
  readonly #now: () => number;
  readonly #onSubscriberError: (error: unknown, event: AnyEvent) => void;

  constructor(opts: EventBusOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#onSubscriberError =
      opts.onSubscriberError ??
      ((error, event) => console.error(`[events] subscriber failed on #${event.seq} ${event.type}:`, error));
  }

  /** 最近一条事件的序号；还没有事件时为 0 */
  get seq(): number {
    return this.#seq;
  }

  /** 从下一条投递的事件开始接收；返回取消订阅的函数 */
  subscribe(fn: Subscriber, filter?: SubscribeFilter): () => void {
    const sub: Subscription = { fn, filter, active: true };
    // 写时复制：投递中途加入的订阅者不会收到正在投递的这一条
    this.#subs = [...this.#subs, sub];
    return () => {
      sub.active = false;
      this.#subs = this.#subs.filter((s) => s !== sub);
    };
  }

  /**
   * 产生一条事件并交给订阅者。序号在此刻确定；
   * 订阅者里再发的事件排在队尾，保证每个订阅者看到的序号严格递增。
   */
  emit<T extends EventType>(type: T, data: EventDataMap[T], run?: RunRef): HarnessEvent<T> {
    const event: Record<string, unknown> = {
      seq: ++this.#seq,
      ts: this.#now(),
      type,
      level: levelOf(type, data),
    };
    if (run) {
      event.runId = run.runId;
      event.rootId = run.rootId;
      if (run.parentId) event.parentId = run.parentId;
      event.operation = run.operation;
    }
    event.data = snapshot(data);
    const frozen = Object.freeze(event) as unknown as HarnessEvent<T>;

    this.#queue.push(frozen as AnyEvent);
    if (!this.#delivering) this.#drain();
    return frozen;
  }

  #drain(): void {
    this.#delivering = true;
    try {
      for (let i = 0; i < this.#queue.length; i++) {
        const event = this.#queue[i]!;
        const subs = this.#subs;
        for (const sub of subs) {
          if (sub.active && accepts(sub.filter, event)) this.#deliver(sub, event);
        }
      }
    } finally {
      this.#queue = [];
      this.#delivering = false;
    }
  }

  #deliver(sub: Subscription, event: AnyEvent): void {
    try {
      const result = sub.fn(event);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).then(undefined, (error) => this.#report(error, event));
      }
    } catch (error) {
      this.#report(error, event);
    }
  }

  #report(error: unknown, event: AnyEvent): void {
    try {
      this.#onSubscriberError(error, event);
    } catch {
      // 报错钩子自己出错也不能打断事件流
    }
  }
}

function accepts(filter: SubscribeFilter | undefined, event: AnyEvent): boolean {
  if (!filter) return true;
  if (filter.levels && !filter.levels.includes(event.level)) return false;
  if (filter.types && !filter.types.includes(event.type)) return false;
  return true;
}
