import { renderCode } from "@ts-capture/examples-site/code";

import { TOKEN_STYLE } from "./stage.js";

// The picture a link to the site shows where it is shared, in the recording's
// colours. Its code is a real example, cut down to the lines apply wrote in.

export const SHARE_CARD = { width: 1200, height: 630 };

const STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; width: ${SHARE_CARD.width}px; height: ${SHARE_CARD.height}px; overflow: hidden;
    box-sizing: border-box; padding: 64px 72px; display: flex; flex-direction: column; gap: 28px;
    background: #0d1117; color: #e6edf3; font-family: system-ui, sans-serif; }
  .name { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 700; }
  .mark { width: 44px; height: 44px; border-radius: 10px; background: #1f5fbf; color: #fff;
    display: grid; place-items: center; font: 700 22px ui-monospace, Menlo, monospace; }
  h1 { margin: 0; font-size: 60px; line-height: 1.1; letter-spacing: -0.02em; }
  p { margin: 0; font-size: 26px; color: #8b949e; }
  pre { margin: auto 0 0; padding: 22px 26px; border: 1px solid #30363d; border-radius: 12px;
    background: #161b22; font: 21px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
  ${TOKEN_STYLE}
  ins { text-decoration: none; background: #17452a; border-radius: 3px; }
`;

export function shareCardHtml(example: {
  before: string;
  after: string;
}): string {
  const changed = renderCode(example.before, example.after)
    .text.split("\n")
    .filter((line) => line.includes("<ins>"))
    .map((line) => line.trim())
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><style>${STYLE}</style></head>
  <body>
    <div class="name"><span class="mark">ts</span>ts-capture</div>
    <h1>Runtime values as TypeScript types</h1>
    <p>ts-capture watches how your code is called and writes the types it saw back into your source.</p>
    <pre><code>${changed}</code></pre>
  </body>
</html>`;
}
