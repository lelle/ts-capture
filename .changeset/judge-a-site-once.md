---
"@ts-capture/core": patch
---

`apply` judges a site by all its observations together. A variable whose initializer can produce a union (`a ?? b`, a ternary, `.find(...)`) was left untyped when each test worker recorded one branch, even if the branches together covered both. It is now annotated when more than one type was observed, and a site observed many times is listed once in `apply --report`.
