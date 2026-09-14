import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist', 'renderer'), { recursive: true });
mkdirSync(join(root, 'dist', 'engine', 'fixtures'), { recursive: true });
cpSync(join(root, 'src', 'renderer'), join(root, 'dist', 'renderer'), { recursive: true });
cpSync(join(root, 'src', 'engine', 'fixtures'), join(root, 'dist', 'engine', 'fixtures'), { recursive: true });
