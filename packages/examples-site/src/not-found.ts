import { type BuildInfo, renderLayout, SITE } from "./layout.js";
import { markup } from "./markup.js";

// GitHub Pages serves this for any missing address, at whatever depth it was
// asked for, so its links start from the site's root.
const ROOT = new URL(SITE).pathname;

export function renderNotFoundPage(build: BuildInfo): string {
  return renderLayout(
    {
      id: "not-found",
      title: "Page not found",
      root: ROOT,
      path: "404.html",
      top: markup`<h1>Page not found</h1>
  <p class="lede">There is no page at this address.</p>`,
      body: markup`<main id="content">
  <ul class="elsewhere">
    <li><a href="${ROOT}">The front page</a>, with the recording and the install line</li>
    <li><a href="${ROOT}docs/">The docs</a>, from getting started to the reference</li>
    <li><a href="${ROOT}examples/">The examples</a>, from real projects</li>
  </ul>
</main>`,
    },
    build,
  );
}
