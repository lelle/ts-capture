// For the specs: jsdom lays nothing out, so how tall the page is is what a
// test says it is.

export function setPageHeight(height: number): void {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: height,
  });
}

export function resetPageHeight(): void {
  Reflect.deleteProperty(document.documentElement, "scrollHeight");
}
