import { detectThreadsTheme, type ThreadsTheme } from "./detectThreadsTheme";

type MutationObserverConstructor = new (
  callback: MutationCallback,
) => MutationObserver;

const attributeFilter = ["data-theme", "data-color-scheme", "class", "style"];

export class ThreadsThemeObserver {
  private observer: MutationObserver | null = null;
  private theme: ThreadsTheme | null = null;

  constructor(
    private readonly observedDocument: Document,
    private readonly subscriber: (theme: ThreadsTheme) => void,
    private readonly Observer: MutationObserverConstructor = MutationObserver,
  ) {}

  start(): ThreadsTheme {
    if (this.observer) return this.theme ?? "light";

    const initialTheme = this.readTheme();
    let observer!: MutationObserver;
    observer = new this.Observer((records) => {
      if (this.observer !== observer || !this.hasThemeChange(records)) return;
      this.refresh();
    });

    try {
      observer.observe(this.observedDocument, {
        attributes: true,
        attributeFilter,
        childList: true,
        subtree: true,
      });
      this.theme = initialTheme;
      this.observer = observer;
      return initialTheme;
    } catch (error) {
      try {
        observer.disconnect();
      } catch {
        // Failed observer startup must remain inert.
      }
      throw error;
    }
  }

  stop(): void {
    const observer = this.observer;
    if (!observer) return;

    this.observer = null;
    this.theme = null;
    try {
      observer.disconnect();
    } catch {
      // Page lifecycle cleanup is best effort.
    }
  }

  private refresh(): void {
    const nextTheme = this.readTheme();
    if (nextTheme === this.theme) return;

    this.theme = nextTheme;
    try {
      this.subscriber(nextTheme);
    } catch {
      // Subscriber failures must not disrupt Threads.
    }
  }

  private hasThemeChange(records: MutationRecord[]): boolean {
    const root = this.observedDocument.documentElement;
    const body = this.observedDocument.body;
    return records.some((record) =>
      record.type === "attributes"
        ? record.target === root || record.target === body
        : record.type === "childList" &&
          (record.target === this.observedDocument ||
            record.target === root ||
            record.target === body),
    );
  }

  private readTheme(): ThreadsTheme {
    try {
      return detectThreadsTheme(this.observedDocument);
    } catch {
      return "light";
    }
  }
}
