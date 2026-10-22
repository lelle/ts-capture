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
import {
  animationArgs,
  coveragePercent,
  stillName,
  terminalLines,
} from "./scenes.js";
import { stageHtml, VIEWPORT } from "./stage.js";

// Records the README demo. The first run is the real one: it produces the
// code, the numbers and the terminal output. Then the stage shows those
// results step by step, the form is filled in again for the browser step,
// and the end of each step is screenshotted, at 1x and at 2x. Nothing on
// screen is written by hand: a change to what ts-capture does changes the
// recording.

const SOURCE = "src/order.ts";
const VITE_CONFIG = "vite.config.ts";
const CAPTURE_CONFIG = "ts-capture.config.json";
// The stage's highlight on written code fades over 1.4 s.
const ARRIVED = 1600;

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

/** The stage at the end of each step, as PNG files, in order. */
async function shoot(measured: Measured, scale: 1 | 2): Promise<string[]> {
  const app = freshApp(`shot-${scale}x`);
  addCapture(app);
  const { server, url } = await serve(app);
  const dir = path.join(WORK_DIR, "stills");
  fs.mkdirSync(dir, { recursive: true });
  const shots: string[] = [];
  const shot = async (page: Page): Promise<void> => {
    const file = path.join(dir, `step${shots.length + 1}@${scale}x.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: scale,
    });
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
    await shot(page);

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
    // The added lines arrive highlighted, then settle; shoot them settled.
    await sleep(ARRIVED);
    await shot(page);

    await onStage(page, "browser", "3", "Use the app", url);
    const form = page.frameLocator("#app");
    await form.locator("#order").waitFor();
    for (const order of ORDERS) await placeOrder(form, order);
    await shot(page);

    await onStage(page, "terminal", "4", "Apply what it observed");
    for (const { command, output } of measured.commands) {
      await onStage(page, "typeCommand", command);
      await onStage(page, "print", output);
    }
    await shot(page);

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
    await sleep(ARRIVED);
    await shot(page);
    return shots;
  } finally {
    await browser.close();
    await server.close();
  }
}

function run(tool: string, args: string[]): void {
  execFileSync(tool, args, { stdio: "inherit" });
}

/** Each still as lossless WebP at both scales, and the README's animation at 2x. */
function encode(stills: Record<1 | 2, string[]>): void {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  for (const scale of [1, 2] as const) {
    stills[scale].forEach((png, i) => {
      const webp = path.join(ASSETS_DIR, stillName(i + 1, scale));
      run("cwebp", ["-quiet", "-lossless", "-z", "9", png, "-o", webp]);
    });
  }
  run("img2webp", animationArgs(stills[2], path.join(ASSETS_DIR, "demo.webp")));
}

const measured = await measure();
console.log(
  `measured: coverage ${measured.coverageBefore} -> ${measured.coverageAfter}; ${measured.commands[0].output.join(" ")}`,
);
encode({ 1: await shoot(measured, 1), 2: await shoot(measured, 2) });
console.log(
  `recorded: ${path.relative(process.cwd(), path.join(ASSETS_DIR, "demo.webp"))} and the stills beside it`,
);
