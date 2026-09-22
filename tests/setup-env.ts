import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll } from 'vitest';

const originalHome = process.env.AGY_BRIDGE_HOME;
const isolatedHome = mkdtempSync(join(tmpdir(), 'agy-bridge-test-'));
process.env.AGY_BRIDGE_HOME = isolatedHome;

afterAll(() => {
  if (originalHome === undefined) delete process.env.AGY_BRIDGE_HOME;
  else process.env.AGY_BRIDGE_HOME = originalHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});
