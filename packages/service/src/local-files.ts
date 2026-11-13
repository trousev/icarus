// A file the agent linked to: a path from the answer → a file on the host.
//
// The model does not "send a file", it writes a link in markdown: `/workspaces/talk/chart.gif`
// or `/artifacts/plany/index.png`. The panel draws an image from such a link, Telegram
// sends it as an attachment — and both channels must understand in the same way which path counts as
// accessible and which leads outside the working folder. That is why there is a single parser for all:
// here, not a copy in each channel.
import fs from 'node:fs';
import path from 'node:path';
import { artifactFile, mimeOf } from './artifacts.ts';
import { CONTAINER_HOME, userPaths, type IcarusConfig, type UserConfig } from './config.ts';

/** Found file: the path on the host and the type that mimeOf knows. */
export type LocalFile = { file: string; type: string };

/** Images that can be served to the browser as an image (SVG — no: it executes scripts). */
const RASTER_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

/** Whether the type is served as an image in the browser: the panel draws it in the chat by the same criterion. */
export function isRasterImage(type: string): boolean {
  return RASTER_IMAGE.has(type.split(';')[0]?.trim() ?? type);
}

/**
 * A path in the agent's answer → a file on the host. null — the path is missing, foreign, or is not a file:
 * a link to someone else's file must not turn into "read the host".
 *
 * We understand three roots that the person's container sees: their own attachments (`incoming/`),
 * working folders (`workspaces/`) and the shared artifact library (`artifacts/`, access
 * by ACL — we do not serve someone else's personal artifact).
 */
export function localFileOf(config: IcarusConfig, user: UserConfig, raw: unknown): LocalFile | null {
  if (typeof raw !== 'string') return null;
  let relative = raw.trim();
  if (!relative || relative.includes('\u0000')) return null;
  if (relative.startsWith('file://')) relative = relative.slice('file://'.length);
  // The MCP server returns the path in markdown encoded (spaces in the folder name), and
  // %2e%2e after decoding still hits the ".." check below anyway.
  if (/%[0-9a-f]{2}/i.test(relative)) {
    try {
      relative = decodeURIComponent(relative);
    } catch {
      return null;
    }
  }
  // We strip the service directory first: after the generic '/workspace/' what would be left of it is
  // '.icarus/incoming/…', and neither incoming/ nor workspaces/ would match anymore.
  if (relative.startsWith(`${CONTAINER_HOME}/`)) relative = relative.slice(CONTAINER_HOME.length + 1);
  else if (relative.startsWith('/workspace/')) relative = relative.slice('/workspace/'.length);
  else if (relative.startsWith('workspace/')) relative = relative.slice('workspace/'.length);
  else if (relative.startsWith('/')) relative = relative.slice(1);

  // Artifacts live in a shared library and follow their own permissions: the path is known only to
  // the owner and those they granted access to.
  if (relative.startsWith('artifacts/')) {
    const [slug, ...rest] = relative.slice('artifacts/'.length).split('/');
    if (!slug || rest.length === 0) return null;
    const found = artifactFile(config, user.id, slug, rest.join('/'));
    return found === null ? null : { file: found.file, type: found.type };
  }

  const paths = userPaths(config, user);
  let root = paths.incoming;
  if (relative.startsWith('incoming/')) relative = relative.slice('incoming/'.length);
  // Files the agent created itself (charts and anything else) live in its
  // workspace: showing them to the person is the only way to convey the result to them.
  else if (relative.startsWith('workspaces/')) {
    root = paths.workspaces;
    relative = relative.slice('workspaces/'.length);
  }

  if (!relative || relative.includes('..')) return null;
  const full = path.resolve(root, relative);
  if (!full.startsWith(path.resolve(root) + path.sep)) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return { file: full, type: mimeOf(full) };
}
