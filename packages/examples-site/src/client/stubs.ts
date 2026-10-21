// For the specs: jsdom lays nothing out and has no media queries, so how tall
// the page is, and which queries match, is what a test says.

export function setPageHeight(height: number): void {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: height,
  });
}

export function resetPageHeight(): void {
  Reflect.deleteProperty(document.documentElement, "scrollHeight");
}

export function stubMatchMedia(matches: (query: string) => boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: matches(query),
    media: query,
  })) as typeof window.matchMedia;
}
