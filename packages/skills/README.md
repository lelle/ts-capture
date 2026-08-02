# @ts-capture/skills

Portable coding-agent skills that complement ts-capture's automated type
inference with guided setup and review.

## Included skills

- `ts-capture-setup`: detects a project's test/build stack, selects the
  appropriate adapter, and configures the first observation run.
- `ts-capture-apply-review`: reviews `apply --dry-run` output for risky
  annotations such as flattened generics and mixed unions.

Each directory is a self-contained skill with YAML metadata and instructions in
`SKILL.md`. It can be used by agents that implement this common skill layout.

## Installation

Install the package in the project where the agent runs:

```sh
npm install --save-dev @ts-capture/skills@next
```

Then link or copy the required skill directories from
`node_modules/@ts-capture/skills/` into the project- or user-level skill
directory recognized by the coding agent. For example, agents using
`.agents/skills/` can link both skills with:

```sh
mkdir -p .agents/skills
ln -s ../../node_modules/@ts-capture/skills/ts-capture-setup .agents/skills/
ln -s ../../node_modules/@ts-capture/skills/ts-capture-apply-review .agents/skills/
```

Consult the agent's documentation for its exact discovery directory. Copy the
directories instead of linking them when the project must pin their contents.

## Usage

Compatible agents use each skill's `description` metadata to select it for a
matching task. Explicit prompts such as "set up ts-capture" or "review this
ts-capture apply diff" also provide reliable activation signals.

The package remains separate from `@ts-capture/core` so runtime consumers do
not install agent instructions they do not use.
