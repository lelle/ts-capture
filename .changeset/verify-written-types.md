---
"@ts-capture/core": minor
---

`ts-capture verify` can now check the types you wrote. Run the tests with `TS_CAPTURE_OBSERVE_ANNOTATED=1` and parameters and return types that already have a type are observed too; `verify` lists them under "Written types", apart from the positions where it checks TypeScript's inference, and `--threshold` then counts only them. `apply` never writes over a type you wrote, with or without the variable. What the text comparison cannot settle, such as a named type the value may well be or a literal type the run widened, is reported as unverifiable rather than as a mismatch. An async return is now compared with what its promise resolved to, and the returns of paren-less arrows and destructured parameters are found.
