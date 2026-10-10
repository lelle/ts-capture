---
"@ts-capture/core": minor
---

With literals on, a union of observed literals is written as the in-scope type alias that unites them: `type Status = "active" | "inactive"` in scope turns `status: "active" | "inactive"` into `status: Status`. The alias is used when the observed arms are all of its arms, or at least two of them and exactly one alias holds them; a single observed literal keeps its inline form. Arms that are not literals stay beside the alias (`Status | undefined`), and the rule applies inside object fields and generic arguments. Part of `preferNamedInScope`, which so far matched object shapes only.
