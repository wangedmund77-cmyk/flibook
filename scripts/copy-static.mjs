import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');

// Vite only copies public/ automatically. Inserted HTML pages live in data/ and
// are requested from /data/... at runtime, so include them in the production
// artifact as well.
await mkdir(resolve(projectRoot, 'dist'), { recursive: true });
await cp(resolve(projectRoot, 'data'), resolve(projectRoot, 'dist/data'), {
    recursive: true,
    force: true,
});

console.log('[build] copied data/ -> dist/data/');
