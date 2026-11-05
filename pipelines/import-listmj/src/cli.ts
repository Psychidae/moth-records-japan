import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { buildListMjImport } from './import.ts';

const args = z.array(z.string().min(1)).max(1).parse(process.argv.slice(2));
const outputDirectory = args[0] ?? 'generated/listmj';
const result = buildListMjImport();
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, 'import.sql'), result.sql);
writeFileSync(join(outputDirectory, 'import_report.json'), `${JSON.stringify(result.report, null, 2)}\n`);
console.log(`List-MJ: ${result.report.counts.species} species, ${result.report.counts.subspecies} subspecies; ${outputDirectory}`);
