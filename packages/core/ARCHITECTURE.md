# Architecture

## Overview

ts-capture is a TypeScript type inference engine that works in three phases:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Instrument  │ ──► │   Collect    │ ──► │    Apply    │
│              │     │              │     │             │
│ Parse AST    │     │ Execute code │     │ Read types  │
│ Find untyped │     │ Observe vals │     │ Build union │
│ Insert calls │     │ Record types │     │ Insert ann. │
└─────────────┘     └──────────────┘     └─────────────┘
```

## Package Structure

```
ts-capture (npm: ts-capture)
├── src/
│   ├── index.ts              Public API (17 exports)
│   ├── instrument.ts         Orchestrator: source → instrumented source
│   ├── transformer.ts        AST visitor, inserts __tscptr__ tracking calls
│   ├── type-collector.ts     Runtime type introspection + CollectionContext
│   ├── apply-types.ts        Insert collected annotations into source
│   ├── replacement.ts        Back-to-front text edit engine
│   ├── compiler-helper.ts    TypeScript program creation from tsconfig
│   ├── type-coverage.ts      Calculate annotation completeness
│   ├── configuration.ts      ts-capture.config.json loading and validation
│   ├── cli.ts                CLI entry point (bin: ts-capture)
│   ├── register.ts           Node --import entry point
│   ├── loader.ts             Node loader hooks for .ts instrumentation
│   └── integration.spec.ts   End-to-end pipeline test

@ts-capture/vite (npm: @ts-capture/vite, separate repo)
├── src/
│   └── index.ts              Vite plugin: transform + dev server middleware
```

## Module Dependency Graph

```
cli.ts ──────────────► instrument.ts ──► transformer.ts
register.ts ─► loader.ts ─┘                    │
                                                ▼
                           compiler-helper.ts ◄─┘
                                    ▲
apply-types.ts ─────────────────────┤
   │                                │
   ├── replacement.ts               │
   └── type-collector.ts (types)    │
                                    │
type-coverage.ts ───────────────────┘
configuration.ts (standalone)
```

## Key Design Decisions

1. **Pure core** — All transformation functions are `string → string`. File I/O is in CLI/register only.
2. **Scoped state** — CollectionContext replaces module-level globals. Multiple contexts can coexist.
3. **Fail loudly** — No silent error swallowing. Config errors produce actionable diagnostics.
4. **ts.factory API** — Uses the stable factory API for TypeScript 6 compatibility.
5. **ESM-only** — No CommonJS dual-packaging complexity.
6. **Hybrid packaging** — Core + CLI + Node runner in one package; Vite plugin separate (peer dep on vite).

## Won't-fix in core (pivot to skills + docs)

Two classes of behavior are accepted as inherent to runtime observation rather than fixed in core. They surface as apply-output quality issues but cannot be solved at the type-collector / apply boundary — the runtime simply doesn't have the information that would be needed.

- **Generics flattening.** A function used as `<T>(x: T) => T` at the call site appears to the runtime as concrete-type calls (`(number) => number`, `(string) => string`, …). ts-capture correctly records each observation, but the _generic relationship_ between argument and return is invisible — the runtime sees independent monomorphic calls, not parametric polymorphism. Result: ts-capture emits a flat union (`(x: number | string) => number | string`) instead of the parametric form. **Mitigation: user-facing.** `apply --dry-run` + manual review; routed to the `ts-capture-apply-review` skill (drafted) and possibly a future `ts-capture-generic-detection` skill.

- **Mixed-union arithmetic.** A function observed receiving both `string` and `number` at the same param position correctly produces a `string | number` annotation. But user code that does `a + b` on the param is now a TS error (`+` doesn't accept the union). The observation is _correct_; the TS-type-system-level consequence makes the annotation user-hostile. **Mitigation: case-by-case judgment via skill-files.** Routed to a planned `ts-capture-union-narrowing` skill.

The pattern shared by both: runtime observation captures what happened, not the _intent_ the user expressed in the source. Closing this gap structurally would require either static analysis (out of scope — that's TypeStat's job, see README's "Pair with TypeStat" section) or proxy-wrapping every value to track propagation (a lazy-cross-position-inference approach, problematized and parked).
