// Writes one of the playground's example projects to a folder, e.g. to run
// the CI action (ci/) on it:  node scripts/write-example.ts hello out/hello
import fs from 'node:fs';
import path from 'node:path';
import { findExample, EXAMPLES } from '../src/examples/index.ts';

const [id, out] = process.argv.slice(2);
const example = id ? findExample(id) : undefined;
if (!example || !out) {
  console.error(`usage: node scripts/write-example.ts <${EXAMPLES.map((e) => e.id).join('|')}> <folder>`);
  process.exit(1);
}
for (const [file, text] of Object.entries(example.files)) {
  const target = path.join(out, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
console.log(`Wrote ${Object.keys(example.files).length} files of ${example.id} to ${out}`);
