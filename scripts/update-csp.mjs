// Writes the Content-Security-Policy into index.html, including the SHA-256 hash
// of the inline import map (the only inline script). Run after editing the import map.
//   node scripts/update-csp.mjs          update index.html
//   node scripts/update-csp.mjs --check  fail if index.html is out of date (used in CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = new URL('../index.html', import.meta.url);
const html = readFileSync(file, 'utf8');
const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
if (!m) throw new Error('import map not found in index.html');
const hash = createHash('sha256').update(m[1], 'utf8').digest('base64');

const csp = [
  "default-src 'self'",
  `script-src 'self' 'sha256-${hash}'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",          // no outbound requests except this site
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const updated = html.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/, `$1${csp}$2`);
if (process.argv.includes('--check')) {
  if (updated !== html) { console.error('index.html CSP is stale — run: node scripts/update-csp.mjs'); process.exit(1); }
  console.log('CSP up to date.');
} else {
  writeFileSync(file, updated);
  console.log(`CSP written (import map sha256-${hash}).`);
}
