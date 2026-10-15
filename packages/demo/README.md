# @ts-capture/demo

The order form in the recording at the top of the repository's README, and the
script that records it.

```sh
pnpm demo        # from the repository root; writes docs/assets/demo.gif and demo.mp4
```

Needs `ffmpeg` on the path and Playwright's Chromium
(`pnpm --filter @ts-capture/demo exec playwright install chromium`).

## What it does

`app/` is the app before ts-capture: a Vite order form whose `src/order.ts`
has no types. `capture/` holds the two files that step two of the
demo adds, the Vite config with the plugin and `ts-capture.config.json`.

The script runs the demo twice, in scratch copies under `.work/`:

1. **Measured, not filmed.** Type coverage is read, the capture files are
   added, a dev server is started, two orders are placed in a real browser,
   and `ts-capture apply` and `ts-capture coverage` are run. The code before
   and after, the two percentages and what the commands printed all come from
   this run.
2. **Filmed.** The same results are shown scene by scene at a pace a reader can
   follow, and the form is filled in again, live, for the browser scene.

So a change to what ts-capture writes changes the recording: run `pnpm demo`
and commit the new `docs/assets/demo.gif` and `demo.mp4`. The project site plays the mp4.
