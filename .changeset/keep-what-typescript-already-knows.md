---
"@ts-capture/core": minor
---

Apply refuses an annotation that would take something away from a type
TypeScript already has.

Five rules, each asked before the annotation is written, and each measured
against a real run on nestjs/nest:

**A polymorphic `this` is never replaced.** A method returning `this` keeps
working in a subclass — `new Sub().addValidator(v)` is a `Sub`. A run only ever
observes the concrete instance it saw, so writing the class name hands every
subclass caller the base class back. Eight nest methods were annotated that way,
all builders. It is refused wherever it hides: bare, in a union, as an array
element, and inside a type argument — `Promise<this>` is the ordinary shape of an
async fluent API, since a builder that awaits cannot return `this` bare. The same
erasure in a binding, `const self = this`, is refused too — and in a `this:`
parameter, where inside a class method the checker's own answer _is_ the
polymorphic `this`.

**No `Function` over a signature TypeScript has.** `Function` is a fair answer
when the run saw a callable it could not describe; it says nothing about arity,
parameters or return. Where the checker already has a real signature, writing it
replaces an answer with a shrug. Six nest sites wrote `Function` over the
`reject` of `new Promise((resolve, reject) => …)`, which TypeScript types
`(reason?: any) => void`, and two wrote `Function[]` over an array of constructor
signatures.

**No structure over a name.** A reader who sees `RouteInfo[]` knows where to
look; `{ method: number, path: string }[]` cannot be checked for completeness —
and on nest several were not complete: one dropped a field, and four turned an
enum into `number`. When the run produces a name TypeScript does not have, the
annotation is the better one and still lands.

**No enum erased into what it is made of.** An enum is a name with meaning
attached; the run sees only the string or number underneath. Writing that
replaces `UuidFactoryMode` with `string` and every
`mode === UuidFactoryMode.Random` downstream stops meaning anything. Wrapping
does not change the loss, so `Promise<Mode>` and `Mode[]` are refused as the bare
enum is.

**Nothing narrower than the checker's own type.** The rules above refuse an
annotation that says _less_ than TypeScript knows. This one refuses the opposite
mistake, which is the more dangerous: a type narrower than the inferred one does
not remove an error, it introduces one. nest's `server-grpc` writes `string`
where the checker has `string | symbol`, and it compiles today only because no
caller passes a symbol yet. A dropped `undefined` or `null` does not count —
`?:` supplies the `undefined` itself.

**`skipRedundantAnnotations` no longer switches these off.** It gated the
TypeChecker itself, so turning it off — a redundancy setting, documented as
nothing more — also disabled every guard above. Asking for redundant annotations
is asking for restatement, not for destruction. The flag now governs only the
redundancy question it names.
