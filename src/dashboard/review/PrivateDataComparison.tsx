import type * as React from "react";

export interface PrivateDataComparisonProps {
  children: React.ReactNode;
  "data-testid"?: string;
}

/** Sources always stack vertically (Phase 3 §46) - never side-by-side, so long notes stay readable. */
export function PrivateDataComparison({ children, "data-testid": dataTestId = "review-sources" }: PrivateDataComparisonProps) {
  return (
    <div className="flex flex-col gap-4" data-testid={dataTestId}>
      {children}
    </div>
  );
}
