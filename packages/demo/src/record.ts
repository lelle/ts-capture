import { renderCode } from "@ts-capture/examples-site/code";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

import type { Stage } from "./stage.js";

import {
  addCapture,
  ASSETS_DIR,
  freshApp,
  observationsWritten,
  ORDERS,
  placeOrder,
  readApp,
  readCapture,
  serve,
  sleep,
  tsCapture,
  TYPES_FILE,
  WORK_DIR,
} from "./run.js";
import { coveragePercent, terminalLines } from "./scenes.js";
import { stageHtml, VIEWPORT } from "./stage.js";

// Records the README demo. The demo is run twice. The first run is the real
// one and is not filmed: it produces the code, the numbers and the terminal
// output. The second is the film, which shows those results at a pace a reader
// can follow and fills the form in again, live, for the browser scene. Nothing
// on screen is written by hand: a change to what ts-capture does changes the
// recording.

const SOURCE = "src/order.ts";
const VITE_CONFIG = "vite.config.ts";
const CAPTURE_CONFIG = "ts-capture.config.json";

interface Measured {
  before: string;
  after: string;
  viteConfigBefore: string;
  coverageBefore: string;
  coverageAfter: string;
  /** The commands of the terminal scene, each with what it printed. */
  commands: Array<{ command: string; output: string[] }>;
}

async function measure(): Promise<Measured> {
  const app = freshApp("measured");
  const before = readApp(app, SOURCE);
  const viteConfigBefore = readApp(app, VITE_CONFIG);
  const coverageBefore = coveragePercent(
    tsCapture(app, ["coverage", "tsconfig.json"]),
  );

  addCapture(app);
  const { server, url } = await serve(app);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url);
    for (const order of ORDERS) await placeOrder(page, order);
    // Leaving the page sends what it has not sent yet.
    await page.goto("about:blank");
    await observationsWritten(app);
  } finally {
    await browser.close();
    await server.close();
  }

  const applied = tsCapture(app, ["apply", TYPES_FILE]);
  const coverage = tsCapture(app, ["coverage", "tsconfig.json"]);
  return {
    before,
    after: readApp(app, SOURCE),
    viteConfigBefore,
    coverageBefore,
    coverageAfter: coveragePercent(coverage),
    commands: [
      {
        command: `npx ts-capture apply ${TYPES_FILE}`,
        output: terminalLines(applied),
      },
      {
        command: "npx ts-capture coverage tsconfig.json",
        output: terminalLines(coverage),
      },
    ],
  };
}

/** Call a method of the page's `window.stage`. */
async function onStage<K extends keyof Stage>(
  page: Page,
  method: K,
  ...args: Parameters<Stage[K]>
): Promise<void> {
  await page.evaluate(
    ([name, values]) => {
      const stage = (
        window as unknown as {
          stage: Record<string, (...a: unknown[]) => unknown>;
        }
      ).stage;
      return stage[name](...values);
    },
    [method, args] as const,
  );
}

/** Film the scenes; returns the video and how long it ran before the first scene. */
async function film(
  measured: Measured,
): Promise<{ video: string; lead: number }> {
  const app = freshApp("filmed");
  addCapture(app);
  const { server, url } = await serve(app);
  const videoDir = path.join(WORK_DIR, "video");
  fs.rmSync(videoDir, { recursive: true, force: true });
  const browser = await chromium.launch();
  const started = Date.now();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  try {
    const page = await context.newPage();
    await page.setContent(stageHtml());

    await onStage(
      page,
      "code",
      "1",
      "A codebase without types",
      [
        {
          title: SOURCE,
          html: renderCode(measured.before, measured.before).text,
        },
      ],
      { text: measured.coverageBefore, tone: "low" },
    );
    const lead = Date.now() - started;
    await sleep(4000);

    await onStage(page, "code", "2", "Add ts-capture to the build", [
      {
        title: VITE_CONFIG,
        html: renderCode(measured.viteConfigBefore, readCapture(VITE_CONFIG))
          .text,
      },
      {
        title: CAPTURE_CONFIG,
        html: renderCode("", readCapture(CAPTURE_CONFIG)).text,
      },
    ]);
    await sleep(4000);

    await onStage(page, "browser", "3", "Use the app", url);
    const form = page.frameLocator("#app");
    await form.locator("#order").waitFor();
    await sleep(600);
    await placeOrder(form, ORDERS[0], 45);
    await sleep(1300);
    await placeOrder(form, ORDERS[1], 30);
    await sleep(1500);

    await onStage(page, "terminal", "4", "Apply what it observed");
    await sleep(400);
    for (const { command, output } of measured.commands) {
      await onStage(page, "typeCommand", command);
      await onStage(page, "print", output);
      await sleep(900);
    }
    await sleep(900);

    await onStage(
      page,
      "code",
      "5",
      "Types, written into your source",
      [
        {
          title: SOURCE,
          html: renderCode(measured.before, measured.after).text,
        },
      ],
      { text: measured.coverageAfter, tone: "full" },
    );
    await sleep(6000);

    const video = await page.video()!.path();
    await context.close();
    return { video, lead };
  } finally {
    await browser.close();
    await server.close();
  }
}

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], {
    stdio: "inherit",
  });
}

function encode(video: string, lead: number): void {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const from = ["-ss", (lead / 1000).toFixed(2), "-i", video];
  ffmpeg([
    ...from,
    "-vf",
    "fps=12,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
    path.join(ASSETS_DIR, "demo.gif"),
  ]);
  ffmpeg([
    ...from,
    "-movflags",
    "+faststart",
    "-pix_fmt",
    "yuv420p",
    path.join(ASSETS_DIR, "demo.mp4"),
  ]);
}

const measured = await measure();
console.log(
  `measured: coverage ${measured.coverageBefore} -> ${measured.coverageAfter}; ${measured.commands[0].output.join(" ")}`,
);
const { video, lead } = await film(measured);
encode(video, lead);
console.log(
  `recorded: ${path.relative(process.cwd(), path.join(ASSETS_DIR, "demo.gif"))}`,
);
