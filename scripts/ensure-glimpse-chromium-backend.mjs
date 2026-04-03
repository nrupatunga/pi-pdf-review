import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';

const target = resolve(process.cwd(), 'node_modules/glimpseui/src/chromium-backend.mjs');

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (await exists(target)) return;

  const url = 'https://raw.githubusercontent.com/hazat/glimpse/main/src/chromium-backend.mjs';
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }

  const text = await res.text();
  if (!text.includes('chromium') || text.length < 5000) {
    throw new Error('Downloaded chromium-backend.mjs looks invalid');
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
  console.log('[pi-pdf-review] Restored missing glimpseui/src/chromium-backend.mjs');
}

main().catch((err) => {
  console.warn(`[pi-pdf-review] Warning: ${err.message}`);
});
