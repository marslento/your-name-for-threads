import type {
  PageContext,
  SurfaceCleanupContext,
  SurfaceReconcileContext,
} from "../runtime/types";

export interface ThreadsSurfaceAdapter {
  id: string;

  isApplicable(context: PageContext): boolean;

  reconcile(context: SurfaceReconcileContext): Promise<void>;

  cleanup(context: SurfaceCleanupContext): void;
}
