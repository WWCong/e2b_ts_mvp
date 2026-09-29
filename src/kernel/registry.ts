/**
 * 注册表与公开表（6.1、7.2）：装配时从全部包一次建成，此后只读。
 * 建表时做跨包检查（11.3）：同名冲突、停用项存在、标签点名的对象存在且可见、
 * 装饰器引用符合内外侧规则、处理器挂在存在的挂点上；有问题一次全部报出。
 */
import { narrow, selects, Surface } from "./capability.ts";
import { EVENT_TYPES } from "./events.ts";
import { snapshot } from "./json.ts";
import type {
  DecoratorDecl,
  DecoratorFn,
  Form,
  HandlerDecl,
  HandlerFn,
  Limits,
  OperationDecl,
  OperationFn,
  OperationName,
  PackageManifest,
} from "./types.ts";

/** 包的模块：导出名 → 值 */
export type PackageModule = Readonly<Record<string, unknown>>;

export interface PackageSource {
  manifest: PackageManifest;
  module: PackageModule;
}

/** 插件在 setup 里定义的自定义挂点 */
export interface HookDecl {
  name: string;
  public: boolean;
}

/** 生命周期责任链：有序、内核等它走完、不公开给 script 包（5.1、R14） */
export const LIFECYCLE_HOOKS: readonly string[] = Object.freeze(["harness.stopping", "run.cancelling"]);

export interface RegistryInput {
  packages: readonly PackageSource[];
  /** 装配配置 `disable`：按名字停用的 Operation，不注册 */
  disable?: readonly OperationName[];
  /** 装配配置 `defaultDecorators`：外 → 内，只能是内侧的 */
  defaultDecorators?: readonly string[];
  hooks?: readonly HookDecl[];
}

export interface OperationEntry {
  readonly name: OperationName;
  readonly package: string;
  readonly version: string;
  readonly form: Form;
  readonly public: boolean;
  readonly usage: string;
  readonly limits: Limits;
  readonly fn: OperationFn;
  readonly surface: Surface;
  /** 链序，外 → 内：默认装饰器在外，自选在内 */
  readonly chain: readonly DecoratorEntry[];
}

export interface DecoratorEntry {
  readonly id: string;
  readonly package: string;
  readonly version: string;
  readonly form: Form;
  readonly public: boolean;
  readonly onError: "open" | "closed";
  readonly usage: string;
  readonly fn: DecoratorFn;
}

export interface HandlerEntry {
  readonly on: string;
  readonly package: string;
  readonly export: string;
  readonly form: Form;
  readonly fn: HandlerFn;
}

/** 装配后可 dump 的全部内容（6.6 第 7 条） */
export interface RegistryDump {
  defaultDecorators: string[];
  disabled: OperationName[];
  operations: {
    name: OperationName;
    package: string;
    version: string;
    form: Form;
    public: boolean;
    usage: string;
    limits: Limits;
    surface: OperationName[];
    chain: string[];
  }[];
  decorators: { id: string; package: string; version: string; form: Form; public: boolean; onError: string }[];
  handlers: { on: string; package: string; export: string; form: Form }[];
  hooks: HookDecl[];
}

/** 外侧能看到的全部（7.2）；服务在 services 模块里补上 */
export interface PublicTable {
  operations: OperationName[];
  decorators: string[];
  hooks: string[];
}

export class RegistryError extends Error {
  override readonly name = "RegistryError";
  constructor(readonly issues: readonly string[]) {
    super(`registry has ${issues.length} issue(s):\n- ${issues.join("\n- ")}`);
  }
}

interface RegistryParts {
  operations: ReadonlyMap<OperationName, OperationEntry>;
  decorators: ReadonlyMap<string, DecoratorEntry>;
  handlers: ReadonlyMap<string, readonly HandlerEntry[]>;
  hooks: ReadonlyMap<string, HookDecl>;
  defaultDecorators: readonly string[];
  disabled: readonly OperationName[];
}

const PACKAGE_NAME = /^[A-Za-z0-9_-]+$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export class Registry {
  readonly #operations: ReadonlyMap<OperationName, OperationEntry>;
  readonly #decorators: ReadonlyMap<string, DecoratorEntry>;
  readonly #handlers: ReadonlyMap<string, readonly HandlerEntry[]>;
  readonly #hooks: ReadonlyMap<string, HookDecl>;
  readonly #defaultDecorators: readonly string[];
  readonly #disabled: readonly OperationName[];

  private constructor(parts: RegistryParts) {
    this.#operations = parts.operations;
    this.#decorators = parts.decorators;
    this.#handlers = parts.handlers;
    this.#hooks = parts.hooks;
    this.#defaultDecorators = parts.defaultDecorators;
    this.#disabled = parts.disabled;
  }

  /** 有问题时抛 RegistryError，列出全部问题 */
  static build(input: RegistryInput): Registry {
    return new Registry(new Builder(input).build());
  }

  /** 没有注册（含已停用）时为 undefined */
  operation(name: OperationName): OperationEntry | undefined {
    return this.#operations.get(name);
  }

  decorator(id: string): DecoratorEntry | undefined {
    return this.#decorators.get(id);
  }

  /** 挂在某个挂点上的处理器，按包的装载顺序 */
  handlers(on: string): readonly HandlerEntry[] {
    return this.#handlers.get(on) ?? [];
  }

  hook(name: string): HookDecl | undefined {
    return this.#hooks.get(name);
  }

  /** 按包的装载顺序 */
  get operations(): readonly OperationEntry[] {
    return [...this.#operations.values()];
  }

  get defaultDecorators(): readonly string[] {
    return this.#defaultDecorators;
  }

  get disabled(): readonly OperationName[] {
    return this.#disabled;
  }

  publicTable(): PublicTable {
    return {
      operations: [...this.#operations.values()].filter((o) => o.public).map((o) => o.name).sort(),
      decorators: [...this.#decorators.values()].filter((d) => d.public).map((d) => d.id).sort(),
      hooks: [...this.#hooks.values()].filter((h) => h.public).map((h) => h.name).sort(),
    };
  }

  dump(): RegistryDump {
    return snapshot({
      defaultDecorators: [...this.#defaultDecorators],
      disabled: [...this.#disabled],
      operations: [...this.#operations.values()].map((o) => ({
        name: o.name,
        package: o.package,
        version: o.version,
        form: o.form,
        public: o.public,
        usage: o.usage,
        limits: o.limits,
        surface: [...o.surface.names],
        chain: o.chain.map((d) => d.id),
      })),
      decorators: [...this.#decorators.values()].map((d) => ({
        id: d.id,
        package: d.package,
        version: d.version,
        form: d.form,
        public: d.public,
        onError: d.onError,
      })),
      handlers: [...this.#handlers.values()].flat().map((h) => ({
        on: h.on,
        package: h.package,
        export: h.export,
        form: h.form,
      })),
      hooks: [...this.#hooks.values()].filter((h) => !isBuiltinHook(h.name)),
    });
  }
}

function isBuiltinHook(name: string): boolean {
  return LIFECYCLE_HOOKS.includes(name) || (EVENT_TYPES as readonly string[]).includes(name);
}

// ─── 建表 ────────────────────────────────────────────────────────────────

/** 已声明的 Operation（含停用的），用于检查标签点名的对象 */
interface Declared {
  name: OperationName;
  manifest: PackageManifest;
  decl: OperationDecl;
  fn: OperationFn;
}

class Builder {
  readonly #input: RegistryInput;
  readonly #issues: string[] = [];
  readonly #packages = new Map<string, PackageManifest>();
  readonly #declared = new Map<OperationName, Declared>();
  readonly #decorators = new Map<string, DecoratorEntry>();
  readonly #handlerDecls: { manifest: PackageManifest; decl: HandlerDecl; fn: HandlerFn }[] = [];
  readonly #hooks = new Map<string, HookDecl>();

  constructor(input: RegistryInput) {
    this.#input = input;
  }

  build(): RegistryParts {
    for (const source of this.#input.packages) this.#addPackage(source);
    this.#addHooks();

    const disabled = this.#checkDisabled();
    const registered = [...this.#declared.values()].filter((d) => !disabled.has(d.name));
    const all = new Surface(registered.map((d) => d.name));
    const pub = new Surface(registered.filter((d) => d.decl.public).map((d) => d.name));
    const defaults = this.#checkDefaultDecorators();

    const operations = new Map<OperationName, OperationEntry>();
    for (const d of registered) {
      const { manifest, decl } = d;
      this.#checkSelectors(d, "only", decl.only ?? []);
      this.#checkSelectors(d, "exclude", decl.exclude);
      const base = manifest.form === "native" ? all : pub;
      operations.set(
        d.name,
        Object.freeze({
          name: d.name,
          package: manifest.name,
          version: manifest.version,
          form: manifest.form,
          public: decl.public,
          usage: decl.usage,
          limits: decl.limits,
          fn: d.fn,
          surface: narrow(base, decl.only, decl.exclude),
          chain: Object.freeze(this.#resolveChain(d, defaults)),
        }),
      );
    }

    for (const id of this.#decorators.keys()) {
      if (this.#declared.has(id)) this.#issue(`decorator ${id}: id collides with an operation name`);
    }
    const handlers = this.#resolveHandlers();

    if (this.#issues.length > 0) throw new RegistryError(this.#issues);
    return {
      operations,
      decorators: this.#decorators,
      handlers,
      hooks: this.#hooks,
      defaultDecorators: Object.freeze(defaults.map((d) => d.id)),
      disabled: Object.freeze([...disabled]),
    };
  }

  #issue(message: string): void {
    this.#issues.push(message);
  }

  #addPackage({ manifest, module }: PackageSource): void {
    const pkg = manifest.name;
    if (!PACKAGE_NAME.test(pkg)) {
      this.#issue(`package "${pkg}": name must match ${PACKAGE_NAME}`);
      return;
    }
    if (this.#packages.has(pkg)) {
      this.#issue(`package ${pkg}: loaded twice`);
      return;
    }
    this.#packages.set(pkg, manifest);

    const exports = new Set<string>();
    const fnOf = (kind: string, name: string): ((...args: any[]) => unknown) | undefined => {
      if (!IDENTIFIER.test(name)) {
        this.#issue(`package ${pkg}: ${kind} export "${name}" is not an identifier`);
        return undefined;
      }
      if (exports.has(name)) {
        this.#issue(`package ${pkg}: export ${name} is declared more than once`);
        return undefined;
      }
      exports.add(name);
      const value = module[name];
      if (typeof value !== "function") {
        this.#issue(`package ${pkg}: ${kind} export ${name} is not a function`);
        return undefined;
      }
      return value as (...args: any[]) => unknown;
    };

    for (const decl of manifest.operations) {
      const name = `${pkg}.${decl.export}`;
      const fn = fnOf("operation", decl.export);
      if (manifest.form === "script" && !decl.public) {
        this.#issue(`operation ${name}: script package exports are always public`);
      }
      if (fn) this.#declared.set(name, { name, manifest, decl: snapshot(decl), fn: fn as OperationFn });
    }

    for (const decl of manifest.decorators) this.#addDecorator(manifest, decl, fnOf("decorator", decl.export));

    for (const decl of manifest.handlers) {
      const fn = fnOf("handler", decl.export);
      if (fn) this.#handlerDecls.push({ manifest, decl, fn: fn as HandlerFn });
    }
  }

  #addDecorator(manifest: PackageManifest, decl: DecoratorDecl, fn: ((...args: any[]) => unknown) | undefined): void {
    const pkg = manifest.name;
    const { id } = decl;
    if (id !== pkg && !(id.startsWith(`${pkg}.`) && IDENTIFIER.test(id.slice(pkg.length + 1)))) {
      this.#issue(`decorator ${id} in package ${pkg}: id must be "${pkg}" or "${pkg}.<identifier>"`);
      return;
    }
    if (this.#decorators.has(id)) {
      this.#issue(`decorator ${id}: registered twice`);
      return;
    }
    if (manifest.form === "script" && !decl.public) {
      this.#issue(`decorator ${id}: script package exports are always public`);
    }
    if (!fn) return;
    this.#decorators.set(
      id,
      Object.freeze({
        id,
        package: pkg,
        version: manifest.version,
        form: manifest.form,
        public: decl.public,
        onError: decl.onError,
        usage: decl.usage,
        fn: fn as DecoratorFn,
      }),
    );
  }

  #addHooks(): void {
    for (const type of EVENT_TYPES) this.#hooks.set(type, { name: type, public: true });
    for (const name of LIFECYCLE_HOOKS) this.#hooks.set(name, { name, public: false });
    for (const hook of this.#input.hooks ?? []) {
      if (this.#hooks.has(hook.name)) {
        this.#issue(`hook ${hook.name}: defined twice or shadows a built-in hook`);
        continue;
      }
      this.#hooks.set(hook.name, Object.freeze({ name: hook.name, public: hook.public }));
    }
  }

  #checkDisabled(): Set<OperationName> {
    const disabled = new Set<OperationName>();
    for (const name of this.#input.disable ?? []) {
      if (!this.#declared.has(name)) this.#issue(`disable: unknown operation ${name}`);
      else disabled.add(name);
    }
    return disabled;
  }

  #checkDefaultDecorators(): DecoratorEntry[] {
    const out: DecoratorEntry[] = [];
    for (const id of this.#input.defaultDecorators ?? []) {
      const entry = this.#decorators.get(id);
      if (!entry) this.#issue(`defaultDecorators: unknown decorator ${id}`);
      else if (entry.form !== "native") this.#issue(`defaultDecorators: ${id} is from a script package`);
      else if (out.includes(entry)) this.#issue(`defaultDecorators: ${id} listed twice`);
      else out.push(entry);
    }
    return out;
  }

  /** 标签点名的对象存在；script 包点名的还要公开（7.4） */
  #checkSelectors(op: Declared, tag: "only" | "exclude", selectors: readonly string[]): void {
    const script = op.manifest.form === "script";
    for (const selector of selectors) {
      const where = `operation ${op.name}: @${tag} ${selector}`;
      if (selector.includes(".")) {
        const target = this.#declared.get(selector);
        if (!target) this.#issue(`${where} names no operation`);
        else if (script && !target.decl.public) this.#issue(`${where} is not public`);
      } else if (!this.#packages.has(selector)) {
        this.#issue(`${where} names no package`);
      } else if (script && ![...this.#declared.values()].some((d) => d.decl.public && selects(selector, d.name))) {
        this.#issue(`${where} has no public operation`);
      }
    }
  }

  /** 默认集在外，自选在内；自选里与默认集重复的沿用默认集的位置（5.2） */
  #resolveChain(op: Declared, defaults: readonly DecoratorEntry[]): DecoratorEntry[] {
    const chain = [...defaults];
    const script = op.manifest.form === "script";
    const seen = new Set<string>();
    for (const id of op.decl.decorators) {
      const where = `operation ${op.name}: @decorators ${id}`;
      if (seen.has(id)) {
        this.#issue(`${where} listed twice`);
        continue;
      }
      seen.add(id);
      const entry = this.#decorators.get(id);
      if (!entry || (script && !entry.public)) {
        // script 包看不到不公开的装饰器，与不存在同样回答
        this.#issue(`${where} names no ${script ? "public " : ""}decorator`);
        continue;
      }
      if (!script && entry.form === "script") {
        // 外侧代码不包住内侧的调用（R14）
        this.#issue(`${where} is from a script package; native operations can only use native decorators`);
        continue;
      }
      if (!chain.includes(entry)) chain.push(entry);
    }
    return chain;
  }

  #resolveHandlers(): Map<string, readonly HandlerEntry[]> {
    const handlers = new Map<string, HandlerEntry[]>();
    for (const { manifest, decl, fn } of this.#handlerDecls) {
      const where = `handler ${manifest.name}.${decl.export}: @on ${decl.on}`;
      const hook = this.#hooks.get(decl.on);
      if (!hook || (manifest.form === "script" && !hook.public)) {
        this.#issue(`${where} names no ${manifest.form === "script" ? "public " : ""}hook`);
        continue;
      }
      const entry: HandlerEntry = Object.freeze({
        on: decl.on,
        package: manifest.name,
        export: decl.export,
        form: manifest.form,
        fn,
      });
      const list = handlers.get(decl.on);
      if (list) list.push(entry);
      else handlers.set(decl.on, [entry]);
    }
    for (const list of handlers.values()) Object.freeze(list);
    return handlers;
  }
}
