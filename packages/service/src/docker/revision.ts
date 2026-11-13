// Fingerprint of the service code for docker compose.
//
// Compose recreates the container when the image, mounts or environment change, but the sources
// arrive in the container via bind-mount and are not part of that comparison. Without a fingerprint
// `docker compose up` leaves the old process with the old code in memory running: the deploy is
// green, /healthz is green, but the stand runs old code. That is how the fix for the "forget" button went
// to main, but in prod the old confirm stayed — the service simply did not restart.
//
// The fingerprint is placed into the service environment (ICARUS_REVISION): code changed — environment
// changed — compose recreates the container and node reads the new code from disk.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** What we count as service code: editing any of these paths must recreate icarus. */
export const SERVICE_CODE = [
  'packages/service/src',
  'packages/extensions',
  'package.json',
  'pnpm-lock.yaml',
];

/** Walks a path and collects files relative to the repository root; skips missing paths. */
function collect(repoRoot: string, entry: string, prefix: string, files: string[]): void {
  const full = path.join(repoRoot, entry);
  const stat = fs.statSync(full, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isFile()) {
    files.push(prefix);
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const child of entries) {
    // node_modules and hidden directories (.git) are not code: their contents change on their own.
    if (child.name === 'node_modules' || child.name.startsWith('.')) continue;
    collect(repoRoot, path.join(entry, child.name), `${prefix}/${child.name}`, files);
  }
}

/**
 * Computes a fingerprint of the code content: path plus the bytes of each file. The walk order
 * is fixed, so the same code yields the same fingerprint, and editing any
 * byte yields a different one. A short hex is enough: this is not protection against forgery but a sign that "the code is different".
 */
export function sourceRevision(repoRoot: string, entries: readonly string[] = SERVICE_CODE): string {
  const files: string[] = [];
  for (const entry of entries) collect(repoRoot, entry, entry, files);

  const hash = createHash('sha256');
  for (const relative of files) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(repoRoot, relative)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
