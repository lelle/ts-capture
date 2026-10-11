import type { CollectionContext, ExtraOptions } from "./collector-contract.js";

/** The `__tscptr__` that instrumented code calls. */
export interface TscptrFn {
  (name: string, value: unknown, pos: number, filename: string, optsJson: string): void;
  track<T>(value: T, filename: string, offset: number): T;
  ret<T>(value: T, pos: number, filename: string, optsJson: string): T;
  registerFn(fn: Function, retPos: number, filename: string): void;
  regFn<F extends Function>(fn: F, retPos: number, filename: string): F;
}

export function createTscptrHook(ctx: CollectionContext): TscptrFn {
  const tscptr = function (
    name: string,
    value: unknown,
    pos: number,
    filename: string,
    optsJson: string,
  ): void {
    ctx.record(name, value, pos, filename, JSON.parse(optsJson) as ExtraOptions);
  } as TscptrFn;
  tscptr.track = (v, f, o) => ctx.track(v, f, o);
  tscptr.ret = function (value, pos, filename, optsJson) {
    ctx.record("(return)", value, pos, filename, JSON.parse(optsJson) as ExtraOptions);
    return value;
  };
  tscptr.registerFn = function (fn, retPos, filename) {
    ctx.registerFn(fn, retPos, filename);
  };
  tscptr.regFn = function (fn, retPos, filename) {
    ctx.registerFn(fn, retPos, filename);
    return fn;
  };
  return tscptr;
}
