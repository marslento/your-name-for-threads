import type { RouteObject } from "react-router-dom";
import { createMemoryRouter } from "react-router-dom";

/**
 * Every Dashboard route mounts ContactEditDrawer, which calls useBlocker - a
 * hook that throws unless the surrounding router was created via
 * createXRouter (not plain <MemoryRouter>). Tests that render a Dashboard
 * page must build their routes through this helper and render the result
 * with <RouterProvider router={...} />.
 */
export function createTestRouter(routes: RouteObject[], initialPath = "/"): ReturnType<typeof createMemoryRouter> {
  return createMemoryRouter(routes, { initialEntries: [initialPath] });
}
