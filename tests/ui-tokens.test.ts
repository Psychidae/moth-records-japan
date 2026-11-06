import { readFileSync,readdirSync } from 'node:fs';
import { describe,it,expect } from 'vitest';
const css=readFileSync('packages/ui/tokens.css','utf8');
const tokens=new Map([...css.matchAll(/--color-([a-z-]+):\s*(#[a-f0-9]{6})/gi)].map(m=>[m[1]!,m[2]!]));
function luminance(hex:string){const rgb=hex.slice(1).match(/../g)!.map(v=>parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return rgb[0]!*0.2126+rgb[1]!*0.7152+rgb[2]!*0.0722;}
function contrast(a:string,b:string){const x=luminance(tokens.get(a)!),y=luminance(tokens.get(b)!);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}
describe('shared design accessibility',()=>{
 it('keeps every text token readable on each light surface and action state',()=>{
  for(const ink of ['ink','muted','accent','accent-hover','warn','danger'])for(const surface of ['paper','surface','raised'])expect(contrast(ink,surface),`${ink}/${surface}`).toBeGreaterThanOrEqual(4.5);
  for(const action of ['accent','accent-hover'])expect(contrast('on-accent',action)).toBeGreaterThanOrEqual(4.5);
  for(const border of ['control','focus'])for(const surface of ['paper','surface','raised'])expect(contrast(border,surface)).toBeGreaterThanOrEqual(3);
 });
 it('uses shared colors, local serif and no downloadable fonts',()=>{
  const source=readFileSync('apps/public/src/styles/global.css','utf8');expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);expect(css).toContain('"Times New Roman"');expect(source+css).not.toMatch(/@font-face|fonts\.google/);
  expect(Object.keys(JSON.parse(readFileSync('apps/public/package.json','utf8')).dependencies)).not.toContain('@fontsource-variable/source-serif-4');
 });
 it('ships all shared components',()=>{
  const names=readdirSync('packages/ui/src/components');for(const name of ['Button','Field','SearchBox','ScientificName','EvidenceBadge','EvidenceLegend','DataTable','Notice','EmptyState','Breadcrumbs','Pagination','CopyButton','PhotoCredit'])expect(names).toContain(`${name}.astro`);
 });
});
