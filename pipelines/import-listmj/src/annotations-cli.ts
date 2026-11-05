import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { buildListMjImport } from './import.ts';
import { buildListMjAnnotations } from './annotations.ts';

const args = z.array(z.string().min(1)).max(1).parse(process.argv.slice(2));
const outputDirectory = args[0] ?? 'generated/listmj';
const result = buildListMjAnnotations();
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, 'annotations.sql'), result.sql);
writeFileSync(join(outputDirectory, 'annotations_report.json'), `${JSON.stringify(result.report, null, 2)}\n`);
writeFileSync(join(outputDirectory, 'import_report.json'), `${JSON.stringify({
  ...buildListMjImport().report, annotations: result.report,
}, null, 2)}\n`);
console.log(`List-MJ annotations: ${result.notes.length} notes, ${result.references.length} real references; expected 282 references, acceptance pending; ${outputDirectory}`);
