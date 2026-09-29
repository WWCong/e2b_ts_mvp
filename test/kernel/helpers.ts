/**
 * 测试用的包：手写清单，模块里的导出缺省是占位函数。
 */
import type { PackageModule, PackageSource } from "../../src/kernel/registry.ts";
import type { DecoratorDecl, Form, HandlerDecl, OperationDecl } from "../../src/kernel/types.ts";

export function op(name: string, extra: Partial<OperationDecl> = {}): OperationDecl {
  return {
    export: name,
    usage: `${name} usage`,
    public: false,
    input: { type: "object" },
    output: {},
    limits: {},
    decorators: [],
    only: null,
    exclude: [],
    ...extra,
  };
}

/** `id` 为 `包名.x` 时导出名取 x，为包名本身时取 `decorate` */
export function deco(id: string, extra: Partial<DecoratorDecl> = {}): DecoratorDecl {
  const dot = id.indexOf(".");
  return {
    export: dot < 0 ? "decorate" : id.slice(dot + 1),
    id,
    onError: "closed",
    public: false,
    usage: `${id} usage`,
    ...extra,
  };
}

export function on(hook: string, exportName: string): HandlerDecl {
  return { export: exportName, on: hook };
}

export function pkg(
  name: string,
  parts: {
    form?: Form;
    version?: string;
    operations?: OperationDecl[];
    decorators?: DecoratorDecl[];
    handlers?: HandlerDecl[];
    module?: Record<string, unknown>;
  } = {},
): PackageSource {
  const form = parts.form ?? "native";
  const script = form === "script";
  const operations = (parts.operations ?? []).map((o) => (script ? { ...o, public: true } : o));
  const decorators = (parts.decorators ?? []).map((d) => (script ? { ...d, public: true } : d));
  const handlers = parts.handlers ?? [];

  const module: Record<string, unknown> = {};
  for (const { export: e } of [...operations, ...decorators, ...handlers]) module[e] = async () => null;
  Object.assign(module, parts.module);

  return {
    manifest: {
      name,
      version: parts.version ?? "1.0.0",
      form,
      summary: `${name} package`,
      operations,
      decorators,
      handlers,
    },
    module: module as PackageModule,
  };
}
