// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Starter } from "./starters.js";

import { setUpControls } from "./controls.js";
import { playgroundLink } from "./link.js";
import { renderPlaygroundPage } from "./page.js";

const STARTERS: Starter[] = [
  { id: "cart", title: "Cart", code: "add(1);\n" },
  {
    id: "json",
    title: "From JSON",
    kind: "json",
    code: '{"id":1}\n',
    options: { aliasRepeatedShapes: true },
  },
];

const element = <T extends HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector)!;

const shownKinds = (): string[] => [
  ...new Set(
    [...document.querySelectorAll<HTMLElement>("[data-kind]")]
      .filter((words) => !words.hidden)
      .map((words) => words.dataset.kind!),
  ),
];

function open(hash = ""): ReturnType<typeof setUpControls> {
  history.replaceState(null, "", `/playground/${hash}`);
  document.body.innerHTML = renderPlaygroundPage(STARTERS, {
    version: "0.4.0",
  });
  return setUpControls(vi.fn());
}

function choose(id: string): void {
  const select = element<HTMLSelectElement>("#starter");
  select.value = id;
  select.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  history.replaceState(null, "", "/playground/");
});

describe("setUpControls", () => {
  it("opens on the first starter, as code", () => {
    const controls = open();
    expect(controls.kind()).toBe("code");
    expect(shownKinds()).toEqual(["code"]);
  });

  it("opens on the starter a #starter= link names, in that starter's words and options", () => {
    const controls = open("#starter=json");
    expect(controls.kind()).toBe("json");
    expect(element<HTMLSelectElement>("#starter").value).toBe("json");
    expect(element<HTMLTextAreaElement>("#code").value).toBe('{"id":1}\n');
    expect(shownKinds()).toEqual(["json"]);
    expect(controls.options().aliasRepeatedShapes).toBe(true);
  });

  it("opens on the code a #code= link carries, as code with no starter", () => {
    const controls = open(
      playgroundLink("f(1);\n", { skipRedundantAnnotations: false }),
    );
    expect(controls.kind()).toBe("code");
    expect(element<HTMLSelectElement>("#starter").value).toBe("");
    expect(element<HTMLTextAreaElement>("#code").value).toBe("f(1);\n");
    expect(controls.options().skipRedundantAnnotations).toBe(false);
  });

  it("switches words and kind with the starter, and clears the link that opened the page", () => {
    const controls = open("#starter=json");
    choose("cart");
    expect(controls.kind()).toBe("code");
    expect(shownKinds()).toEqual(["code"]);
    expect(element<HTMLTextAreaElement>("#code").value).toBe("add(1);\n");
    expect(window.location.hash).toBe("");
  });

  it("tells the page a starter was chosen, so it can clear the last result", () => {
    history.replaceState(null, "", "/playground/");
    document.body.innerHTML = renderPlaygroundPage(STARTERS, {
      version: "0.4.0",
    });
    const chosen = vi.fn();
    setUpControls(chosen);
    choose("json");
    expect(chosen).toHaveBeenCalledOnce();
  });

  it("reads the name and the depth for JSON, leaving an empty depth to core's default", () => {
    const controls = open("#starter=json");
    element<HTMLInputElement>("#root-name").value = "  order ";
    expect(controls.json()).toEqual({ name: "order", maxDepth: undefined });
    element<HTMLInputElement>("#max-depth").value = "8";
    expect(controls.json()).toEqual({ name: "order", maxDepth: 8 });
    element<HTMLInputElement>("#max-depth").value = "";
    expect(controls.json().maxDepth).toBeUndefined();
  });

  it("takes the kind from the starter the browser restored, not from the first", () => {
    document.body.innerHTML = renderPlaygroundPage(STARTERS, {
      version: "0.4.0",
    });
    element<HTMLSelectElement>("#starter").value = "json";
    const controls = setUpControls(vi.fn());
    expect(controls.kind()).toBe("json");
    expect(shownKinds()).toEqual(["json"]);
  });

  it("leaves a depth below one to core's default", () => {
    const controls = open("#starter=json");
    for (const depth of ["0", "-1"]) {
      element<HTMLInputElement>("#max-depth").value = depth;
      expect(controls.json().maxDepth).toBeUndefined();
    }
  });

  it("counts the options changed from the defaults", () => {
    open();
    const box = element<HTMLInputElement>("#infer-narrowParamShapes");
    box.checked = true;
    element(".options").dispatchEvent(new Event("change", { bubbles: true }));
    expect(element("#changed").textContent).toBe("1 changed from the defaults");
  });
});
