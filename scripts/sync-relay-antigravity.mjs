import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const relay = process.env.RELAY_AI_SRC
  || join(root, '..', 'relay-ai', 'src', 'antigravity');

const files = [
  ['fixtures/fetchAvailableModels.json', 'src/engine/fixtures/fetchAvailableModels.json'],
  ['fixtures/loadCodeAssist.json', 'src/engine/fixtures/loadCodeAssist.json'],
  ['slot-registry.ts', 'src/engine/slot-registry.ts'],
];

if (!existsSync(relay)) {
  console.error(`relay-ai antigravity sources not found at ${relay}`);
  console.error('Set RELAY_AI_SRC or keep this repo next to relay-ai.');
  process.exit(1);
}

for (const [from, to] of files) {
  const src = join(relay, from);
  const dest = join(root, to);
  if (!existsSync(src)) {
    console.error(`missing ${src}`);
    process.exit(1);
  }
  copyFileSync(src, dest);
  console.log(`synced ${from} -> ${to}`);
}

console.log('Catalog/slot files copied. Re-apply local import headers if needed, then run npm test.');
