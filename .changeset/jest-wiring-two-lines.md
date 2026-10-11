---
"@ts-capture/skills": patch
---

The setup skill now gives the Jest wiring as two added lines: the plugin in `babel.config.js`, beside the presets the project already has, and `setupFiles: ["@ts-capture/babel-plugin/runtime"]` in `jest.config.js`. It showed a Babel config cut down to `@babel/preset-typescript`, which fails every Jest suite, and never showed the Jest line that loads the collector — without which the suite passes and nothing is written.
