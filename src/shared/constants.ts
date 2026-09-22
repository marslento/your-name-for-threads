import { version } from "../../package.json";

/**
 * The extension's version, from package.json and from nowhere else (Phase 4 Task 29; review checklist 35 and 36). The
 * manifest, About, the popup, the diagnostics and the Recovery export all read this, and a release tag has to be
 * `v` plus it. It is a named import so the bundler keeps this one string and not the rest of package.json.
 * The name is from Phase 1 and is kept so nothing else has to change.
 */
export const PHASE_ONE_VERSION: string = version;
