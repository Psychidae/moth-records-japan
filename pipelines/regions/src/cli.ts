import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { buildRegionImport } from './import.ts';

const args = z.array(z.string().min(1)).max(1).parse(process.argv.slice(2));
const outputDirectory = args[0] ?? 'generated/regions';
const result = buildRegionImport();
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, 'regions.sql'), result.sql);
writeFileSync(join(outputDirectory, 'regions.json'), `${JSON.stringify(result.regions, null, 2)}\n`);
writeFileSync(join(outputDirectory, 'adjacency.json'), `${JSON.stringify(result.adjacency, null, 2)}\n`);
writeFileSync(join(outputDirectory, 'regions_report.json'), `${JSON.stringify(result.report, null, 2)}\n`);
console.log(`Regions: ${result.report.counts.prefectures} prefectures, ${result.report.counts.islands} islands, ${result.report.counts.other} other; ${outputDirectory}`);
