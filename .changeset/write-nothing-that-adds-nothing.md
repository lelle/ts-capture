---
"@ts-capture/core": minor
---

Apply writes nothing that adds nothing, and overwrites nothing narrower than
what it would write.

**An annotation must describe the value.** `unknown` or `any` anywhere in the
payload means the run saw the value and could not say what it was.
`Promise<unknown>` reports that something is a Promise while discarding the part
a reader needs, and where TypeScript already had a real type it is a downgrade.
On nestjs/nest this was the largest single group in the diff — 106 of 366
emitted fragments, led by 25 `Promise<unknown>`, 7 `Map<unknown, unknown>` and 6
each of `Set<unknown>` and `Observable<unknown>`. A type is not vacuous as soon
as one position is described: `(arg: string) => unknown` still tells a reader
the callback takes a string.

**A nullish arm does not speak for its union.** The check stopped at the first
arm that described something, and `null` describes something — so any union
containing it was called informative however empty its other arms were. Eleven
annotations survived on that alone, seven of them replacing
`MessageHandler<any, any, any> | null` with
`((...argsArray: unknown[]) => unknown) | null`, which is worse than what it
replaced. `void` counts as such an arm too: as a union member it makes the same
claim `undefined` does.

**`unknown` absorbs the union it is in.** `unknown | undefined` _is_ `unknown`,
and TypeScript collapses it before apply sees it — but not inside a generic
argument, where the union survived and read as informative. Joining a union
now also parenthesises function types: `((a: T) => R) | string` and
`(a: T) => R | string` are different types, and apply emitted the second while
meaning the first.

**A narrowing the code already has is never widened.** `as const` is the author
saying "keep this as narrow as possible", and a runtime observation can only be
wider — one such annotation turned nest's exported `EnhancerSubtype` from
`"guard" | "interceptor" | "pipe" | "filter"` into `string`, and neither `tsc`
nor the project's suite noticed. `const x = Symbol('x')` is the same narrowing
inferred rather than asked for: writing `: symbol` discards `unique symbol` and
one annotation on `VERSION_NEUTRAL` produced three compile errors in files that
never mention it. Neither waits on `skipRedundantAnnotations` — asking for
redundant annotations is asking for restatement, not for destruction.

**Parentheses that gain no type are not written.** A paren-less arrow needs
`(x) => …` before an annotation can attach, and the wrap was emitted whether or
not any annotation survived to use it. A nest run produced 175 such lines —
`key => …` rewritten to `(key) => …` with nothing gained — 36% of the whole
diff.
