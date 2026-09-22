import { copyFileSync, existsSync, readFileSync } from 'node:fs';
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

const sources = files.map(([from, to]) => {
  const src = join(relay, from);
  if (!existsSync(src)) {
    console.error(`missing ${src}`);
    process.exit(1);
  }
  return { from, to, src, content: readFileSync(src, 'utf8') };
});

const modelsFixture = sources.find(item => item.from === 'fixtures/fetchAvailableModels.json');
try {
  const parsed = JSON.parse(modelsFixture.content);
  if (!parsed || typeof parsed !== 'object' || !parsed.models || typeof parsed.models !== 'object') {
    throw new Error('fetchAvailableModels.json has no models object');
  }
} catch (error) {
  console.error(`invalid ${modelsFixture.src}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const slotRegistry = sources.find(item => item.from === 'slot-registry.ts');
for (const requiredExport of ['getValidatedAgySwitchSlots', 'validateAgySlotRegistry']) {
  if (!slotRegistry.content.includes(requiredExport)) {
    console.error(`${slotRegistry.src} is missing ${requiredExport}`);
    process.exit(1);
  }
}

for (const { from, to, src } of sources) {
  const dest = join(root, to);
  copyFileSync(src, dest);
  console.log(`synced ${from} -> ${to}`);
}

const modelCount = Object.keys(JSON.parse(modelsFixture.content).models).length;
console.log(`Catalog/slot files copied and validated (${modelCount} catalog models). Run npm test next.`);
