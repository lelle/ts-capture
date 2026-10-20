export const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf7; --surface: #ffffff; --text: #1d1c1a; --muted: #6b675f; --line: #e4e0d8;
  --code-bg: #f6f4ef; --accent: #1f5fbf;
  --add-bg: #c9eed1;
  --good: #1f7a3a; --weak: #a55b00; --left: #5b5fb0;
  --kw: #8a2f8f; --type: #0b6e8a; --str: #9a4a12; --num: #1a6b52; --com: #7b776e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15161a; --surface: #1c1e24; --text: #e9e7e2; --muted: #9c988f; --line: #2c2f38;
    --code-bg: #121318; --accent: #8fb8ff;
    --add-bg: #1f5230;
    --good: #6fd08a; --weak: #f0b35a; --left: #a9adf5;
    --kw: #d691da; --type: #6fc7e0; --str: #e8a878; --num: #86d6b8; --com: #8a8780;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main, .top, footer { max-width: 1180px; margin: 0 auto; padding: 0 20px; }
a { color: var(--accent); }
code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.top { padding-top: 44px; padding-bottom: 8px; }
nav.site { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 22px; margin: 0 0 28px; font-size: 14px; }
nav.site a { text-decoration: none; }
nav.site a:hover { text-decoration: underline; }
nav.site > a { font-weight: 650; color: var(--text); }
nav.site .pages, nav.site .out { display: flex; flex-wrap: wrap; gap: 6px 16px; }
nav.site .out { margin-left: auto; }
nav.site a[aria-current="page"] { color: var(--text); font-weight: 650; text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 5px; }
footer.site { background: linear-gradient(var(--line), var(--line)) 20px 0 / calc(100% - 40px) 1px no-repeat; margin-top: 40px; padding-top: 20px; padding-bottom: 48px; }
footer.site p { margin: 0 0 4px; }
h1 { font-size: clamp(28px, 4.5vw, 42px); line-height: 1.15; margin: 0 0 14px; letter-spacing: -0.01em; text-wrap: balance; }
.lede { font-size: 18px; max-width: 68ch; margin: 0 0 12px; }
.how { color: var(--muted); max-width: 68ch; margin: 0 0 8px; }
.filters { display: flex; flex-wrap: wrap; gap: 10px 24px; padding: 18px 0 6px; position: sticky; top: 0; background: var(--bg); z-index: 1; border-bottom: 1px solid var(--line); }
.filters div { display: flex; flex-wrap: wrap; gap: 6px; }
.filters button {
  font: inherit; font-size: 14px; padding: 5px 12px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--line); background: var(--surface); color: var(--text);
}
.filters button[aria-pressed="true"] { background: var(--text); color: var(--bg); border-color: var(--text); }
.filters button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.example { padding: 34px 0 30px; border-bottom: 1px solid var(--line); }
.example[hidden] { display: none; }
.example h2 { font-size: 21px; line-height: 1.3; margin: 0 0 8px; text-wrap: balance; }
.example h2 a { color: inherit; text-decoration: none; }
.example h2 a:hover { text-decoration: underline; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: 0 0 16px; font-size: 14px; color: var(--muted); }
.verdict { font-weight: 600; padding: 1px 9px; border-radius: 999px; border: 1px solid currentColor; }
.verdict-good { color: var(--good); } .verdict-weak { color: var(--weak); } .verdict-left { color: var(--left); }
.file { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
.panes { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
figure { margin: 0; min-width: 0; }
figcaption { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 6px; }
figcaption code { text-transform: none; letter-spacing: 0; font-size: 12px; }
pre {
  margin: 0; padding: 14px 16px; background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px;
  font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2;
}
ins { text-decoration: none; background: var(--add-bg); border-radius: 3px; padding: 1px 0; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.t-keyword { color: var(--kw); } .t-type { color: var(--type); } .t-string { color: var(--str); }
.t-number { color: var(--num); } .t-comment { color: var(--com); font-style: italic; }
.caption { max-width: 76ch; margin: 16px 0 0; }
.note { max-width: 76ch; margin: 12px 0 0; padding: 10px 14px; border-left: 3px solid var(--line); background: var(--surface); font-size: 15px; }
.note code { font-size: 13.5px; overflow-wrap: anywhere; }
.better { border-left-color: var(--weak); }
.note-label, .left-alone dt { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.left-alone { border-left-color: var(--left); display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; }
.left-alone dd { margin: 0; overflow-wrap: anywhere; }
.empty { padding: 30px 0; color: var(--muted); }
footer, .sources { color: var(--muted); font-size: 14.5px; }
.sources { padding-top: 30px; }
.sources h2 { font-size: 16px; color: var(--text); margin: 0 0 8px; }
.sources ul { padding-left: 18px; margin: 0 0 14px; }
.sources li { margin-bottom: 6px; max-width: 86ch; }
.sources code { font-size: 13px; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 18px 0 14px; }
.controls label { font-size: 14px; color: var(--muted); }
.controls select, .controls button {
  font: inherit; font-size: 15px; padding: 6px 14px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--surface); color: var(--text);
}
.controls button { cursor: pointer; background: var(--text); color: var(--bg); border-color: var(--text); font-weight: 600; }
.controls button:disabled { opacity: 0.55; cursor: progress; }
.controls select:focus-visible, .controls button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.status { font-size: 14px; color: var(--muted); }
.status.failed { color: var(--weak); }
textarea {
  display: block; width: 100%; min-height: 340px; flex: 1; resize: vertical; margin: 0; padding: 14px 16px;
  background: var(--surface); color: var(--text); border: 1px solid var(--line); border-radius: 8px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13.5px; line-height: 1.6; tab-size: 2;
}
.playground figure { display: flex; flex-direction: column; }
.result pre { min-height: 340px; flex: 1; }
.outcome { margin: 18px 0 0; }
.outcome pre { background: var(--surface); }
.outcome pre:empty { display: none; }
.limits { color: var(--muted); max-width: 76ch; font-size: 15px; padding: 26px 0 0; }
.limits li { margin-bottom: 6px; }
.demo { margin: 8px 0 14px; }
.demo video { display: block; width: 100%; max-width: 960px; height: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--code-bg); }
.demo figcaption { text-transform: none; letter-spacing: 0; font-size: 14px; max-width: 76ch; margin: 8px 0 0; }
main h2 { font-size: 21px; margin: 34px 0 12px; }
.install { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 14px; }
.install li { min-width: 0; }
.install h3 { font-size: 15px; margin: 0 0 6px; }
.install pre { margin-bottom: 6px; }
.package { white-space: nowrap; }
.install a { font-size: 14px; }
main > .how { margin: 16px 0 0; }
main > .note { border-left-color: var(--weak); margin-top: 26px; }
@media (max-width: 760px) {
  .panes { grid-template-columns: minmax(0, 1fr); }
  .top { padding-top: 28px; }
  pre { font-size: 12.5px; padding: 12px; }
}
`;
