import { render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect } from "vitest";

/**
 * Renders the Dashboard and waits until it has finished asking storage whether this account's data can be
 * read safely (Phase 4 Task 19). Until then it shows a "checking" screen and nothing private: the check is
 * one asynchronous read, so a test that asserts on a route straight after `render` has to wait for it.
 */
export async function renderApp(ui: ReactElement) {
  const view = render(ui);
  await waitFor(() => expect(view.container.querySelector('[aria-busy="true"]')).toBeNull());
  return view;
}
