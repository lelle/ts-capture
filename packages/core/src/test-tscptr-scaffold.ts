// Builds the JS lines that wire up a __tscptr__ mock for the inline `new Function`
// runners in e2e.spec.ts and register.spec.ts. Lines reference an outer `ctx`
// binding. Mirrors loader.ts so partial mocks don't silently break tests when
// new __tscptr__ methods land — that's the bug this helper exists to prevent.
export function buildTscptrScaffoldLines(): string[] {
  return [
    `function tscptr(name, value, pos, filename, optsJson) { ctx.record(name, value, pos, filename, JSON.parse(optsJson)); }`,
    `tscptr.track = (v, f, o) => ctx.track(v, f, o);`,
    `tscptr.ret = (v, p, f, o) => { ctx.record("(return)", v, p, f, JSON.parse(o)); return v; };`,
    `tscptr.registerFn = (fn, retPos, filename) => ctx.registerFn(fn, retPos, filename);`,
    `tscptr.regFn = (fn, retPos, filename) => { ctx.registerFn(fn, retPos, filename); return fn; };`,
  ];
}
