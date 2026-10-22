# @ts-capture/demo

The order form in the recording at the top of the repository's README, and the
script that records it. Also the picture a link to the site shows where it is
shared.

```sh
pnpm demo        # from the repository root; writes docs/assets/demo.webp and demo-1…5.webp
pnpm og-image    # writes docs/assets/og.png, from a real example in examples.json
```

Needs `cwebp` and `img2webp` on the path (libwebp: `brew install webp`) and
Playwright's Chromium
(`pnpm --filter @ts-capture/demo exec playwright install chromium`).

## What it does

`app/` is the app before ts-capture: a Vite order form whose `src/order.ts`
has no types. `capture/` holds the two files that step two of the
demo adds, the Vite config with the plugin and `ts-capture.config.json`.

The script runs the demo in scratch copies under `.work/`:

1. **Measured.** Type coverage is read, the capture files are
   added, a dev server is started, two orders are placed in a real browser,
   and `ts-capture apply` and `ts-capture coverage` are run. The code before
   and after, the two percentages and what the commands printed all come from
   this run.
2. **Shot,** once at 1x and once at 2x. The same results are shown on a
   stage step by step, the form is filled in again for the browser step, and
   the end of each step is screenshotted.

So a change to what ts-capture writes changes the recording: run `pnpm demo`
and commit the new files in `docs/assets/`. They are lossless WebP, so code
in them stays sharp: `demo.webp` is the five steps animated, at 2x, for the
README; `demo-<n>.webp` and `demo-<n>@2x.webp` are the steps one by one, for
the project site's front page.
