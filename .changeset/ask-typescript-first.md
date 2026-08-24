---
"@ts-capture/core": minor
---

Apply asks TypeScript what it already knows before writing an annotation.

**`infer.skipInferableVarDecls` is renamed to `infer.skipRedundantAnnotations`
and now defaults to `true`.** It also covers more: return types and parameters,
not just variable declarations.

The annotations it removes are not merely redundant — on a `const` they are
lossy. `const FLAG = 'on'` has the literal type `'on'`; writing
`const FLAG: string = 'on'` widens it and throws that information away. The
same holds for `Symbol()` (`unique symbol` → `symbol`) and for a return type the
body already implies. Against nestjs/nest the old default emitted 105 such
widening annotations, and 300 redundant var/field annotations in total — 28% of
the whole diff. Set `skipRedundantAnnotations: false` to restore the previous
behaviour.

**Both appliers ask the checker.** The offset-based applier had no checker check
at all, and because it also serves pass-through entries when `cstAware` is on,
redundant annotations reached disk on the default path: all 23 `: void`
annotations in a nestjs/nest run came from there, restating a return type
TypeScript infers from the body. The CST applier hands over its Program-resolved
site index along with the inverse of the rebasing it applied, so positions line
up; driven directly, the offset applier builds the index itself.

**The question is about types, not spellings.** The check compared the checker's
printed type against the string ts-capture was about to write, and the two never
matched: the printer spaces its union bars and separates object members with
semicolons where ts-capture uses a bare bar and a comma, neither sorts, and the
printer quotes no numeric key. So no union and no object type was ever
recognised as a restatement — 20 annotations on nestjs/nest, 11% of everything
the run wrote, including `{ err: string, id: string, status: string }` against
`{ id: string; status: string; err: string; }` five times over.

Both sides now go through one canonical form. It keeps everything that changes
what a reader may do with the value — `readonly`, optionality, literal types,
which members exist, and a function type's arity, optional and rest parameters —
and discards what does not, including parameter names, which are not part of a
function type's identity. The checker's type is printed with `NoTruncation`: the
default width elides a long object type as `... 8 more ...`, which matches no
type at all and hid a 22-field restatement.
