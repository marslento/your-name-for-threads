import { vi } from "vitest";

/**
 * How many grapheme segments `run` takes out of Intl.Segmenter. A length check answers the same whether it stopped
 * at its limit or read a megabyte, so a bounded check is tested on this, the work, and not on its answer.
 */
export function segmentsPulled(run: () => unknown): number {
  const segment = Intl.Segmenter.prototype.segment;
  let pulled = 0;
  const spy = vi.spyOn(Intl.Segmenter.prototype, "segment").mockImplementation(function (this: Intl.Segmenter, input: string) {
    const segments = segment.call(this, input);
    return {
      *[Symbol.iterator]() {
        for (const item of segments) {
          pulled += 1;
          yield item;
        }
      },
    } as unknown as Intl.Segments;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return pulled;
}
