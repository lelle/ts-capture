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

let answer: (query: string) => boolean = () => false;
let listeners: (() => void)[] = [];

export function stubMatchMedia(matches: (query: string) => boolean): void {
  answer = matches;
  listeners = [];
  window.matchMedia = ((query: string) => ({
    get matches() {
      return answer(query);
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => {
      listeners.push(listener);
    },
  })) as unknown as typeof window.matchMedia;
}

/** As if the system's settings changed: the queries answer anew, and say so. */
export function changeMedia(matches: (query: string) => boolean): void {
  answer = matches;
  for (const listener of listeners) listener();
}
