export type AuthorOccurrenceType = "feed" | "reply" | "quote";

export interface AuthorOccurrence {
  readonly occurrenceKey: string;
  readonly type: AuthorOccurrenceType;

  readonly username: string;

  readonly authorLink: HTMLAnchorElement;
  readonly identityCluster: HTMLElement;
  readonly metadataRow: HTMLElement;

  readonly sourceRoot: Node;
}

export interface FindMetadataRowResult {
  readonly row: HTMLElement;
  readonly insertionReference: Node | null;
  readonly mode: "primary" | "fallback";
}
