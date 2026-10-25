# @ts-capture/vite

## 0.5.2

### Patch Changes

- Updated dependencies [[`397c2ef`](https://github.com/lelle/ts-capture/commit/397c2efa76060da23d9f9d6c91150e9054023c76)]:
  - @ts-capture/core@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [[`77e3d18`](https://github.com/lelle/ts-capture/commit/77e3d189dfe68765f7626ce8518d25f4d9a40863)]:
  - @ts-capture/core@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [[`d900c26`](https://github.com/lelle/ts-capture/commit/d900c26d41fd72e11068ae6e5cc509ad77f6c387), [`a2b8835`](https://github.com/lelle/ts-capture/commit/a2b88357d253b4d75174156ab6f4b565ef72365b), [`2378aad`](https://github.com/lelle/ts-capture/commit/2378aad4cc121a27b33a0756b7b78a40af37ab41), [`61730fa`](https://github.com/lelle/ts-capture/commit/61730fa4146429d8e92f23ff966b3cd897cca766), [`b1fe1a4`](https://github.com/lelle/ts-capture/commit/b1fe1a478b3b9ffc79913e0aaab75703dc12e3eb), [`9981af1`](https://github.com/lelle/ts-capture/commit/9981af12cbb1ad5fdc54a6459d271e5cdf144ae8)]:
  - @ts-capture/core@0.5.0

## 0.4.0

### Patch Changes

- [`5c83dfd`](https://github.com/lelle/ts-capture/commit/5c83dfdb841b34399b848921e8df828b5f694730) Thanks [@lelle](https://github.com/lelle)! - `apply: true` now writes through the same applier as `ts-capture apply`, on syntax alone, so the two follow the same rules.
- Updated dependencies [[`cad80a5`](https://github.com/lelle/ts-capture/commit/cad80a5871f0034019ae6cec0d59db2927bf6a53), [`3ebb3a5`](https://github.com/lelle/ts-capture/commit/3ebb3a5adc5b6907c493b185aad3a8d5aac672ad), [`75d2677`](https://github.com/lelle/ts-capture/commit/75d26774088f2ad2790b21bd99ba4764d97e3c36), [`dfc6fe4`](https://github.com/lelle/ts-capture/commit/dfc6fe49b3367dacc4a94b12716d8f86e2600e66), [`60c2eac`](https://github.com/lelle/ts-capture/commit/60c2eacbc563c8fd01d5070d27d21246ff5b4886), [`2ce8db8`](https://github.com/lelle/ts-capture/commit/2ce8db83d2e57e0f355196f6b3e128432cca4710), [`085191a`](https://github.com/lelle/ts-capture/commit/085191a83542b276acfd6785ed23d1383be9d929), [`3837b9d`](https://github.com/lelle/ts-capture/commit/3837b9db1e70398519439de8280ff7faa029c249), [`85f4723`](https://github.com/lelle/ts-capture/commit/85f47236c3db6172ef78171aff0e2fdf27635b05), [`aefbe20`](https://github.com/lelle/ts-capture/commit/aefbe201b90ddad8e42446d935ff0da7e3fe199f), [`3f921d7`](https://github.com/lelle/ts-capture/commit/3f921d73806172542e656a9eb886ce796b5033a2), [`1da26ec`](https://github.com/lelle/ts-capture/commit/1da26ec8ac40f44ec59843ac69a8ccd5337066e7), [`fd5c4bd`](https://github.com/lelle/ts-capture/commit/fd5c4bd5b763915b3347c1dee1546e939efa2ac2), [`a287dc0`](https://github.com/lelle/ts-capture/commit/a287dc0d03f95e3e7dff2a76b76fdb455ff6a325), [`a5080c8`](https://github.com/lelle/ts-capture/commit/a5080c887b038c746a51a45e57da185a02f5c043), [`63988f6`](https://github.com/lelle/ts-capture/commit/63988f64d2e3f4a6b9d06ee9b0761b1b7bf426ab), [`fd710be`](https://github.com/lelle/ts-capture/commit/fd710be78f85f6eb50674532035a66d70a361f08), [`b159994`](https://github.com/lelle/ts-capture/commit/b15999465b9fdbe2965adace9372de1526ab716d), [`0e4ab1a`](https://github.com/lelle/ts-capture/commit/0e4ab1a49b6c1ec159c6c838df884925ff97df30), [`901d8ea`](https://github.com/lelle/ts-capture/commit/901d8ea664406418ef095a11571c50f16fecb1c6), [`585185c`](https://github.com/lelle/ts-capture/commit/585185c1203f85332b5a26f6a1db099a4e2695e7)]:
  - @ts-capture/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`d21c07e`](https://github.com/lelle/ts-capture/commit/d21c07eb0eb861c9fce89177a31322c954261933)]:
  - @ts-capture/core@0.3.0

## 0.2.0

### Minor Changes

- [#5](https://github.com/lelle/ts-capture/pull/5) [`0764495`](https://github.com/lelle/ts-capture/commit/076449571ef9f76879df39c3938143760d113284) Thanks [@lelle](https://github.com/lelle)! - The Vite plugin can be switched off without removing it from the config. `enabled: false` leaves nothing instrumented, writes no dumps and mounts no dev-server middleware; `TS_CAPTURE_ENABLED=false` in the environment does the same for one run. Until now every test run with the plugin configured instrumented all files and wrote dumps to the temp directory, and the only ways around it were a conditional plugin list or `exclude: /./`.

### Patch Changes

- [`982ccd2`](https://github.com/lelle/ts-capture/commit/982ccd291bd6dc5d52dce10de51c1c969e29cb2e) Thanks [@lelle](https://github.com/lelle)! - In the browser, a function that returns a promise is now observed as what the promise resolved to (`Promise<T>`), as under Node, instead of a bare `Promise`. A promise that rejects records nothing. Following the promise registers a reaction, which marks a rejection as handled.

- [#5](https://github.com/lelle/ts-capture/pull/5) [`044fba2`](https://github.com/lelle/ts-capture/commit/044fba226893412f5b16cdb7447c9c4c7e5854f1) Thanks [@lelle](https://github.com/lelle)! - The collectors decide whether to rewrite the dump from a cheap change counter instead of building the collected output each time. On hono's suite (3944 tests) an instrumented run with the Vite plugin takes about as much CPU as 0.1.0 while now resolving callback types, and wall-clock time is lower. `CollectionContext` gains `revision()`, which changes whenever `getCollectedTypes()` would return something different.

- [#5](https://github.com/lelle/ts-capture/pull/5) [`132e6aa`](https://github.com/lelle/ts-capture/commit/132e6aa4439307991cdebb6bcf49c4d57fc0ba88) Thanks [@lelle](https://github.com/lelle)! - A type first seen at an already-observed position late in a run is now written to the dump. The collectors only rewrote the dump when a new position appeared, so a later `null` or second union member at a known position stayed in memory and never reached `types.json`. Annotations that were silently missing a union member, or dropped because the incomplete type failed the type-check, can now be written.

- [`aeb1fb1`](https://github.com/lelle/ts-capture/commit/aeb1fb173b2debc9a06d9e5d233eef1459e9a907) Thanks [@lelle](https://github.com/lelle)! - The package pages on npm now link to the project site, https://lelle.github.io/ts-capture/, which plays the README recording, shows what ts-capture wrote into real projects and has a playground that runs in the browser.

- [#5](https://github.com/lelle/ts-capture/pull/5) [`3c61ec0`](https://github.com/lelle/ts-capture/commit/3c61ec0fbe8e59de9ad37179bd92ae42c7a8a78a) Thanks [@lelle](https://github.com/lelle)! - A function returning a hand-built promise now gets a return type. The runtime keeps returned promises aside and, at each flush, records the value of every one that has fulfilled as `Promise<T>` at the return position; it used to record `Promise<unknown>`, which `apply` drops. A promise's state is read without touching it, so a rejected promise is left exactly as it was and unhandled-rejection reporting is unchanged. Node runtimes only: the browser collector is as before. The Babel runtime and the Vite plugin call the new sweep before flushing.

- [#5](https://github.com/lelle/ts-capture/pull/5) [`8a64d3f`](https://github.com/lelle/ts-capture/commit/8a64d3f12158463f2ca15cc53b112928cf0fa2ef) Thanks [@lelle](https://github.com/lelle)! - A short array of mixed element kinds is observed as a tuple: `[key, value]` holding a string and a number is written `[string, number]` instead of `Array<number | string>`. Arrays of two or three elements qualify when their elements are of more than one kind, with literals widened for the comparison; same-kind and longer arrays stay arrays. At one position, same-arity tuples merge element-wise, and a tuple seen beside an array or a tuple of another length widens back to an array. The Vite browser collector mirrors the rule, and now spaces the element union of a mixed array the way core does.

- [#5](https://github.com/lelle/ts-capture/pull/5) [`7ec6895`](https://github.com/lelle/ts-capture/commit/7ec6895af01955f114a3a8d150af59fd91b4d4d8) Thanks [@lelle](https://github.com/lelle)! - An object that appears more than once inside an observed value is now described every time, instead of as `unknown` from its second appearance on. The cycle guard remembered every object it had walked rather than only the ancestors of the current one, so two orders sharing one customer produced `customer: unknown` and annotations such as `lines: unknown | Line[]`. True cycles are still cut.

- [#5](https://github.com/lelle/ts-capture/pull/5) [`991b071`](https://github.com/lelle/ts-capture/commit/991b0714f74c7e48fe237b97bed259b954a339ca) Thanks [@lelle](https://github.com/lelle)! - Under Node (Vitest, SSR) the plugin now collects through `@ts-capture/core`'s own collector instead of its built-in copy. A parameter that receives a callback is typed with the signature observed for that callback, such as `fn: (value: number) => number`, where it used to stay untyped. The built-in collector remains for the browser and as the fallback when the core package cannot be resolved from the running module.
- Updated dependencies [[`56318cc`](https://github.com/lelle/ts-capture/commit/56318ccb78aa1838c8123e41c6d760296aa641e3), [`0bc7c28`](https://github.com/lelle/ts-capture/commit/0bc7c28e0b212fc11f14384b3d3fb8fce5021085), [`44e2ef4`](https://github.com/lelle/ts-capture/commit/44e2ef4927ce7a7f17b6b4f2ff3e9567dfe2adc6), [`394ecb1`](https://github.com/lelle/ts-capture/commit/394ecb11f6c068a8bed8d45c9ed228a67a55a8b2), [`e3d7de2`](https://github.com/lelle/ts-capture/commit/e3d7de2ddefba00ee53b2316d03c79dfa845b101), [`b41be36`](https://github.com/lelle/ts-capture/commit/b41be36e4f9a776b4a968680b2dd5e46a3229f05), [`6989dc3`](https://github.com/lelle/ts-capture/commit/6989dc318863040345610b8511a093bbc7c99bf7), [`044fba2`](https://github.com/lelle/ts-capture/commit/044fba226893412f5b16cdb7447c9c4c7e5854f1), [`9dd0cfd`](https://github.com/lelle/ts-capture/commit/9dd0cfdeef035e55f4f9e1b4a1b0f4d59be26a92), [`132e6aa`](https://github.com/lelle/ts-capture/commit/132e6aa4439307991cdebb6bcf49c4d57fc0ba88), [`aeb1fb1`](https://github.com/lelle/ts-capture/commit/aeb1fb173b2debc9a06d9e5d233eef1459e9a907), [`451bd0b`](https://github.com/lelle/ts-capture/commit/451bd0b1b8a392e6a4f0c7633d047aae79ce4f61), [`df9815d`](https://github.com/lelle/ts-capture/commit/df9815d4b2855a59b8d44732b98014f9dba618dc), [`1835f45`](https://github.com/lelle/ts-capture/commit/1835f45bfb0987ff1cea2e4b3813e983b0a6b2b1), [`8191939`](https://github.com/lelle/ts-capture/commit/81919397d5e964176eb18825def0aa6bd355692a), [`4664ab1`](https://github.com/lelle/ts-capture/commit/4664ab159a4053ff454de7c986a69c1282545d72), [`2e4ef6d`](https://github.com/lelle/ts-capture/commit/2e4ef6d4f0f19ed6a181c4fa0388c5dd9d355e14), [`3c61ec0`](https://github.com/lelle/ts-capture/commit/3c61ec0fbe8e59de9ad37179bd92ae42c7a8a78a), [`8a64d3f`](https://github.com/lelle/ts-capture/commit/8a64d3f12158463f2ca15cc53b112928cf0fa2ef), [`bcff6d1`](https://github.com/lelle/ts-capture/commit/bcff6d156e32be5dbe7b0f1ab673fe1fada34f28), [`8982422`](https://github.com/lelle/ts-capture/commit/898242297b7bdfd7174f26da4b03c2e49f442582), [`ad616fa`](https://github.com/lelle/ts-capture/commit/ad616fa77a990e16a7e4171ff8643f697e7bb281), [`7ec6895`](https://github.com/lelle/ts-capture/commit/7ec6895af01955f114a3a8d150af59fd91b4d4d8), [`d4046e9`](https://github.com/lelle/ts-capture/commit/d4046e98fe20c8694cf48fdb1bf485f76bf0e42d), [`2883fbc`](https://github.com/lelle/ts-capture/commit/2883fbc7117ecce17e55dd3bd4cb2041d513d20f), [`701f7a9`](https://github.com/lelle/ts-capture/commit/701f7a9eb62373edbb0f4f5e4e04a70c2bc38ae5), [`b1f8b0b`](https://github.com/lelle/ts-capture/commit/b1f8b0b80e336bbeba29a37f765f6dfaab937140), [`73c11fa`](https://github.com/lelle/ts-capture/commit/73c11fabd5a26d42efb980c4a6315a5f0c1128c5), [`b5d2455`](https://github.com/lelle/ts-capture/commit/b5d24559804dc95839024f79bb4f9afe614c5a6b)]:
  - @ts-capture/core@0.2.0
