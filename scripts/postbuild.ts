import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const indexPath = join(import.meta.dirname, '..', 'index.d.ts');
const customTypesPath = join(import.meta.dirname, '..', 'lib', 'types.d.ts');

const existing = readFileSync(indexPath, 'utf-8');
const custom = readFileSync(customTypesPath, 'utf-8');

// Check if custom types are already included
if (!existing.includes('declare function serve(')) {
  writeFileSync(indexPath, existing + '\n' + custom);
  console.log('Merged custom types into index.d.ts');
} else {
  console.log('Custom types already present in index.d.ts');
}