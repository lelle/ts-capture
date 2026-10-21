# @ts-capture/examples-site

The project site: the front page, Examples, How it decides, the Playground
and the docs. Private; it is published to GitHub Pages, never to npm.

```sh
pnpm examples   # from the repository root; writes site/
pnpm site       # serves site/ at http://localhost:4173/ts-capture/; the playground does not run from file:
```

## The pages

| Page           | Source                | Built from                                                                             |
| -------------- | --------------------- | -------------------------------------------------------------------------------------- |
| Home           | `src/home.ts`         | the recording made by [`@ts-capture/demo`](../demo)                                    |
| Examples       | `src/page.ts`         | [`docs/examples/examples.json`](../../docs/examples/README.md)                         |
| How it decides | `src/how-it-decides/` | `cells.ts`, each cell run through the playground's applier at build                    |
| Playground     | `src/playground/`     | `starters.ts`; runs `@ts-capture/core/browser` in a worker                             |
| Docs           | `src/docs/`           | `docs/**/*.md`, menu from `docs/README.md`, code coloured by Shiki                     |
| 404            | `src/not-found.ts`    | nothing; Pages serves it for any missing address, so its links start at `/ts-capture/` |

`src/build.ts` writes them all to `site/`, copies the stylesheets and bundles
the browser scripts with esbuild.

## How a page is made

- **`layout.ts`** holds what every page shares: the head, the bar, the footer,
  the stylesheets, the scripts and the share card's tags. A page calls
  `renderLayout` with its id, title, description and content; a page deeper
  than one level adds its `path`, from which its links to the rest of the
  site are worked out.
- **The theme** follows the system until the reader flips the switch in the
  bar. `js/theme.js` is loaded in `<head>`, not as a module, so a saved choice
  is set before the page is drawn; `site.css` gives every colour as
  `light-dark(light, dark)`.
- **`markup.ts`** builds HTML. `` markup`…` `` escapes every value put into it
  unless it is `Markup` already; `join` puts a separator between items.
  `trusted(text)` marks text as HTML, and belongs only where HTML is made by
  code that escapes as it goes: the token colouring in `code.ts`, the Shiki
  mapping, the Markdown renderer. The tag is not called `html` because
  Prettier would format it, and change what the pages send.
- **`src/client/`** holds the browser scripts, one module per behaviour, and
  `src/client/pages/` one entry per page; the playground's is
  `src/playground/main.ts`, with the worker it starts. No script is inline.
- **`src/styles/`** holds the CSS: `site.css` for every page, and a sheet of
  its own for a page that needs one (see `OWN_STYLESHEET` in `layout.ts`).

## What the tests guard

- `cells.spec.ts`: every card on How it decides still ends where it says, and
  the function it names is in the file it names.
- `docs/site.spec.ts`: every docs page is in the menu, and every link and
  stylesheet on a docs page leads somewhere that exists.
- `docs/repeats.spec.ts` (run from `site.spec.ts`): no twelve words in a row
  appear in two docs, so each fact keeps one home.
- `src/client/*.spec.ts`: the scripts, run against each page's real HTML in
  jsdom. jsdom lays nothing out, so what the How it decides menu marks while
  scrolling is checked in a browser only.
- `layout.spec.ts`: the five pages share one bar and footer, and each loads
  the stylesheets it should.

## Publishing

`.github/workflows/pages.yml` builds the site on every push to `main` that
touches `docs/`, `packages/core/` or this package, and publishes it once Pages
is switched on for the repository with "GitHub Actions" as its source.
