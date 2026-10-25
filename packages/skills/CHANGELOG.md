# @ts-capture/skills

## 0.1.2

### Patch Changes

- [`397f4ab`](https://github.com/lelle/ts-capture/commit/397f4ab8e88b0f0bfc38c9185e8fee833d424c9f) Thanks [@lelle](https://github.com/lelle)! - `engines` says Node `>=20.19`, the oldest Node the packages run on: `@ts-capture/babel-plugin` loads Babel 8 with `require()`, which Node supports for ES modules from 20.19. `@ts-capture/babel-plugin` lists its `types` condition first, so TypeScript resolves its declarations by the condition rather than by the file next to the JavaScript.

## 0.1.1

### Patch Changes

- [`aeb1fb1`](https://github.com/lelle/ts-capture/commit/aeb1fb173b2debc9a06d9e5d233eef1459e9a907) Thanks [@lelle](https://github.com/lelle)! - The package pages on npm now link to the project site, https://lelle.github.io/ts-capture/, which plays the README recording, shows what ts-capture wrote into real projects and has a playground that runs in the browser.

- [#7](https://github.com/lelle/ts-capture/pull/7) [`62493c0`](https://github.com/lelle/ts-capture/commit/62493c06dabaaf1b82105a7030b3632289c69498) Thanks [@lelle](https://github.com/lelle)! - The setup skill now gives the Jest wiring as two added lines: the plugin in `babel.config.js`, beside the presets the project already has, and `setupFiles: ["@ts-capture/babel-plugin/runtime"]` in `jest.config.js`. It showed a Babel config cut down to `@babel/preset-typescript`, which fails every Jest suite, and never showed the Jest line that loads the collector — without which the suite passes and nothing is written.

- [#7](https://github.com/lelle/ts-capture/pull/7) [`2e29b08`](https://github.com/lelle/ts-capture/commit/2e29b08f59e831853a251ee78f478fc3fbe0b291) Thanks [@lelle](https://github.com/lelle)! - Commands in the skills are now written `npx ts-capture …`, as the how-tos and the tutorial write them. The binary is installed into the project's `node_modules/.bin`, so the bare `ts-capture` the skills printed is "command not found" when typed as shown.

- [#7](https://github.com/lelle/ts-capture/pull/7) [`93b49c0`](https://github.com/lelle/ts-capture/commit/93b49c08e2956b56266815dc5f6f81ef7ddca042) Thanks [@lelle](https://github.com/lelle)! - The setup skill now writes the Vitest plugin the way the docs do, `import tsCapture from "@ts-capture/vite"`. The README, the how-to, the Vite package README and the skill each had a quick start of their own, and they disagreed on the import, the worker option and the dump directory.

- [#7](https://github.com/lelle/ts-capture/pull/7) [`6df4733`](https://github.com/lelle/ts-capture/commit/6df4733adf216a5f447742a4da9da233c25bec42) Thanks [@lelle](https://github.com/lelle)! - The apply-review skill has a seventh pattern: object shapes that describe the test data rather than the code. It names three marks — literal keys on a value indexed by a variable, a required field the function body never reads, a lookup typed as if it always hits — says what to suggest for each, and for the second gives a check to run at every object-typed parameter, with what `infer.narrowParamShapes` covers of it and what it leaves.

- [#7](https://github.com/lelle/ts-capture/pull/7) [`4023ac1`](https://github.com/lelle/ts-capture/commit/4023ac1d3e5ab3a58a008114180330b17d4b2438) Thanks [@lelle](https://github.com/lelle)! - The apply-review skill now says what is left after apply: a strict project usually still fails typecheck, because unexercised code is not observed, test files are skipped and an annotation that would add an error is not written. It points at `apply --report` for the positions and their reasons, which the review path never mentioned.

- [#7](https://github.com/lelle/ts-capture/pull/7) [`35a52f4`](https://github.com/lelle/ts-capture/commit/35a52f4462119f8c930682fc3b976f41110cb991) Thanks [@lelle](https://github.com/lelle)! - The setup skill now says which files to ignore: `.ts-capture/`, `types.json` and `types.json.applied`. It created all three in the project and asked for a commit before `apply`, without ever mentioning `.gitignore`.

- [#7](https://github.com/lelle/ts-capture/pull/7) [`4d33cbd`](https://github.com/lelle/ts-capture/commit/4d33cbdee15ed58bf6c1be09b11af068fa6547d3) Thanks [@lelle](https://github.com/lelle)! - The setup skill no longer writes a worker setting into the Vitest config by default. For Vitest 4 and later it wrote `fileParallelism: false` as the way to a single worker, which runs the files one after another and still starts a process for each — twice the run time on a small suite, for nothing. Running in one process is now advice for a suite where the instrumented run is slow or hangs, with the two options it takes on Vitest 4+ and what turning isolation off costs.

- [#7](https://github.com/lelle/ts-capture/pull/7) [`42cfaa4`](https://github.com/lelle/ts-capture/commit/42cfaa4211c3423ea3cc91a22bd2dc0ec2886f61) Thanks [@lelle](https://github.com/lelle)! - Both skills now have a path for an agent that was asked to do the work, not to advise on it. They assumed a user who confirms each edit, runs each command and applies each fix; an agent told to adopt ts-capture broke those instructions every time and then had no guidance at all. The setup skill says which confirmations are already given. The apply-review skill says what may be edited, to run the typecheck and the tests after editing, and to report what was changed, what was flagged and left, and what still fails.
