---
"@ts-capture/core": patch
---

A return type TypeScript already inferred before the run is left to TypeScript also when it holds a generic with defaults, such as a returned `(call: Call) => Promise<void>` where `Call` is `interface Call<T = any>`. TypeScript spelled the type before the run as `Call<any>` and at the return as `Call`, so apply took them for two types and wrote the return out.
