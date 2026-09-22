export interface PageContext {
  readonly document: Document;
  readonly url: string;
  readonly generation: number;
}

export type ReconcileScope =
  | { type: "full" }
  | { type: "subtree"; roots: readonly Node[] };

export interface SurfaceReconcileContext {
  readonly page: PageContext;
  readonly scope: ReconcileScope;
}

export interface SurfaceCleanupContext {
  readonly page: PageContext;
}
