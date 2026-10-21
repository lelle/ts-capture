/** Home: play the recording, unless the reader asked for less motion. */
export function playDemo(): void {
  const video = document.querySelector<HTMLVideoElement>(".demo video")!;
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    video.play().catch(() => {});
  }
}
