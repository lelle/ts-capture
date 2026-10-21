import type { Locator } from "playwright";

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

// The demo, run for real: a scratch copy of the app, the two files that turn
// capture on, a dev server, and the ts-capture CLI.

const PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
/** Where the recording and the share card are written, for the site and README. */
export const ASSETS_DIR = path.resolve(
  PACKAGE_DIR,
  "..",
  "..",
  "docs",
  "assets",
);
const APP_DIR = path.join(PACKAGE_DIR, "app");
const CAPTURE_DIR = path.join(PACKAGE_DIR, "capture");
export const WORK_DIR = path.join(PACKAGE_DIR, ".work");
const CLI = path.join(PACKAGE_DIR, "node_modules", ".bin", "ts-capture");

/** The file `ts-capture apply` reads, named by `capture/vite.config.ts`. */
export const TYPES_FILE = "types.json";

export interface FormOrder {
  name: string;
  email: string;
  sku: string;
  qty: string;
  payment: "card" | "invoice";
  discountCode: string;
}

/** Two orders that between them take both payment methods, with and without a code. */
export const ORDERS: FormOrder[] = [
  {
    name: "Ada Lovelace",
    email: "ada@example.com",
    sku: "TEE-BLACK-M",
    qty: "2",
    payment: "card",
    discountCode: "",
  },
  {
    name: "Grace Hopper",
    email: "grace@example.com",
    sku: "CAP-NAVY-OS",
    qty: "1",
    payment: "invoice",
    discountCode: "AUTUMN-10",
  },
];

/** A fresh copy of the app as it is before ts-capture: no plugin, no types. */
export function freshApp(name: string): string {
  const dir = path.join(WORK_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(APP_DIR, dir, { recursive: true });
  return dir;
}

/** Step two of the demo: the plugin in the Vite config, and the apply settings. */
export function addCapture(appDir: string): void {
  for (const file of fs.readdirSync(CAPTURE_DIR)) {
    fs.copyFileSync(path.join(CAPTURE_DIR, file), path.join(appDir, file));
  }
}

export function readApp(appDir: string, file: string): string {
  return fs.readFileSync(path.join(appDir, file), "utf8");
}

export function readCapture(file: string): string {
  return fs.readFileSync(path.join(CAPTURE_DIR, file), "utf8");
}

/** Run the ts-capture CLI in the app and return what it printed. */
export function tsCapture(appDir: string, args: string[]): string {
  return execFileSync(CLI, args, {
    cwd: appDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function serve(
  appDir: string,
): Promise<{ server: ViteDevServer; url: string }> {
  // The plugin writes `outputFile` relative to the working directory.
  process.chdir(appDir);
  const server = await createServer({ root: appDir, logLevel: "error" });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("the dev server has no local address");
  return { server, url };
}

/** Anything with the form in it: a page, or the frame the stage shows it in. */
export interface FormHost {
  locator(selector: string): Locator;
}

/** Fill the form in and place the order, as a person would; resolves once the receipt shows. */
export async function placeOrder(
  host: FormHost,
  order: FormOrder,
  keyDelay = 0,
): Promise<void> {
  const receipt = host.locator("#receipt");
  const previous = await receipt.textContent();
  const type = async (field: string, text: string): Promise<void> => {
    const input = host.locator(`[name=${field}]`);
    await input.fill("");
    if (text) await input.pressSequentially(text, { delay: keyDelay });
  };
  await type("name", order.name);
  await type("email", order.email);
  await host.locator("[name=sku]").selectOption(order.sku);
  await host.locator("[name=qty]").fill(order.qty);
  await host.locator(`[name=payment][value=${order.payment}]`).check();
  await type("discountCode", order.discountCode);
  await host.locator("button").click();
  await receipt.and(host.locator(":not([hidden])")).waitFor();
  while ((await receipt.textContent()) === previous) await sleep(50);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/** Wait for the plugin to have written the observations the browser sent. */
export async function observationsWritten(appDir: string): Promise<void> {
  const file = path.join(appDir, TYPES_FILE);
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline)
      throw new Error(`the browser's observations never reached ${file}`);
    await sleep(100);
  }
  // The page's last flush follows the one that created the file.
  await sleep(1000);
}
