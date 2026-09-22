export const EXPECTED_PERMISSIONS: string[];
export const EXPECTED_HOSTS: string[];
export const SECRET_PATTERNS: Array<[string, RegExp]>;

export interface Finding {
  rule: string;
  path: string;
  message: string;
}

export function auditPackage(dir: string, options?: { packageJson?: string }): { files: number; findings: Finding[] };
export function auditReleaseGates(root?: string): Finding[];
export function checkReleaseTag(tag: string | undefined, version: string | undefined): Finding[];
export function run(argv: string[], options?: { cwd?: string; log?: (line: string) => void; env?: Record<string, string | undefined> }): number;
