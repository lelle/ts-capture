// The page the recording is a video of. One scene is visible at a time; the
// recorder drives it through `window.stage`.

export const VIEWPORT = { width: 960, height: 720 };

export interface CodePanel {
  title: string;
  html: string;
}

export interface Stage {
  code(step: string, caption: string, panels: CodePanel[], badge?: Badge): void;
  browser(step: string, caption: string, url: string): void;
  terminal(step: string, caption: string): void;
  typeCommand(command: string): Promise<void>;
  print(lines: string[]): Promise<void>;
}

export interface Badge {
  text: string;
  tone: "low" | "full";
}

/** The colours of highlighted code, shared with the share card. */
export const TOKEN_STYLE = `.t-keyword { color: #ff7b72; } .t-string { color: #a5d6ff; } .t-number { color: #79c0ff; }
  .t-type { color: #79c0ff; } .t-comment { color: #8b949e; } .t-name { color: #e6edf3; }
  ins { text-decoration: none; background: #17452a; border-radius: 3px; }`;

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; overflow: hidden;
    background: #0d1117; color: #e6edf3; font-family: system-ui, sans-serif; }
  header { height: 48px; padding: 0 20px; display: flex; align-items: center; gap: 12px;
    border-bottom: 1px solid #30363d; background: #161b22; }
  #step { width: 26px; height: 26px; border-radius: 50%; background: #2f6feb; color: #fff;
    font-weight: 700; font-size: 14px; display: grid; place-items: center; }
  #caption { font-size: 17px; font-weight: 600; flex: 1; }
  #badge { font: 600 13px ui-monospace, Menlo, monospace; padding: 5px 10px; border-radius: 999px; }
  #badge:empty { display: none; }
  #badge.low { background: #4d2d00; color: #f0b429; }
  #badge.full { background: #0f3d1f; color: #56d364; }
  .scene { display: none; height: ${VIEWPORT.height - 48}px; }
  .scene.on { display: block; }
  .tab { font: 12px ui-monospace, Menlo, monospace; color: #8b949e; padding: 9px 20px 0; }
  pre { margin: 0; padding: 8px 20px 10px; font: 14px/20.5px ui-monospace, Menlo, monospace;
    white-space: pre; tab-size: 2; }
  ${TOKEN_STYLE}
  ins { animation: arrive 1.4s ease-out; }
  @keyframes arrive { from { background: #2ea043; color: #fff; } to { background: #17452a; } }
  #browser { padding: 16px 90px; }
  .window { height: 100%; border: 1px solid #30363d; border-radius: 10px; overflow: hidden;
    background: #f4f5f7; display: flex; flex-direction: column; }
  .bar { height: 36px; background: #21262d; display: flex; align-items: center; gap: 7px;
    padding: 0 14px; font: 12px ui-monospace, Menlo, monospace; color: #8b949e; }
  .bar i { width: 11px; height: 11px; border-radius: 50%; background: #484f58; }
  .bar span { margin-left: 14px; }
  iframe { flex: 1; border: 0; width: 100%; }
  #terminal pre { padding-top: 28px; font-size: 15px; line-height: 24px; white-space: pre-wrap; }
  #terminal .prompt { color: #56d364; }
  #terminal .out { color: #c9d1d9; }
`;

/** Runs in the page: `window.stage`, as described by `Stage`. */
function install(): void {
  const byId = (id: string): HTMLElement => document.getElementById(id)!;
  const pause = (ms: number): Promise<void> =>
    new Promise((done) => setTimeout(done, ms));
  const show = (scene: string, step: string, caption: string): void => {
    for (const el of document.querySelectorAll(".scene"))
      el.classList.toggle("on", el.id === scene);
    byId("step").textContent = step;
    byId("caption").textContent = caption;
  };
  const badge = (value?: Badge): void => {
    byId("badge").textContent = value ? `type coverage ${value.text}` : "";
    byId("badge").className = value?.tone ?? "";
  };
  const terminal = byId("terminal").querySelector("pre")!;
  const stage: Stage = {
    code(step, caption, panels, value) {
      byId("code").innerHTML = panels
        .map(
          (panel) =>
            `<div class="tab">${panel.title}</div><pre>${panel.html}</pre>`,
        )
        .join("");
      badge(value);
      show("code", step, caption);
    },
    browser(step, caption, url) {
      byId("address").textContent = url.replace(/^https?:\/\//, "");
      (byId("app") as HTMLIFrameElement).src = url;
      badge();
      show("browser", step, caption);
    },
    terminal(step, caption) {
      terminal.textContent = "";
      badge();
      show("terminal", step, caption);
    },
    async typeCommand(command) {
      const line = document.createElement("div");
      line.innerHTML = '<span class="prompt">$ </span>';
      terminal.append(line);
      for (const character of command) {
        line.append(character);
        await pause(28);
      }
      await pause(350);
    },
    async print(lines) {
      for (const text of lines) {
        const line = document.createElement("div");
        line.className = "out";
        line.textContent = text;
        terminal.append(line);
        await pause(140);
      }
    },
  };
  (window as unknown as { stage: Stage }).stage = stage;
}

export function stageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><style>${STYLE}</style></head>
  <body>
    <header><div id="step"></div><div id="caption"></div><div id="badge"></div></header>
    <section class="scene" id="code"></section>
    <section class="scene" id="browser">
      <div class="window">
        <div class="bar"><i></i><i></i><i></i><span id="address"></span></div>
        <iframe id="app" title="The order form"></iframe>
      </div>
    </section>
    <section class="scene" id="terminal"><pre></pre></section>
    <script>(${install.toString()})();</script>
  </body>
</html>`;
}
