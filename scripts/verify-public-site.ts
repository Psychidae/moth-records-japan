import { readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cloudflareHeaders } from '../apps/public/src/lib/headers.ts';
export function assertSafeHtml(html:string):void {
  if(/<style\b|\sstyle\s*=|\son[a-z]+\s*=|<script(?![^>]*\bsrc\s*=)/i.test(html)) throw new Error('Public HTML contains inline executable content');
  for(const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)/gi)) if(!match[1]?.startsWith('/') || match[1].startsWith('//')) throw new Error('Public script must use the same origin');
}
export function publicFiles(root:string):string[] {
  return readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?publicFiles(join(root,entry.name)):[join(root,entry.name)]);
}
export function verifySite(root='apps/public/dist') {
  const files=publicFiles(root);
  if(readFileSync(join(root,'_headers'),'utf8')!==cloudflareHeaders) throw new Error('Static Assets headers mismatch');
  const html=files.filter(path=>path.endsWith('.html'));
  if(!html.length) throw new Error('No public pages generated');
  for(const path of html) assertSafeHtml(readFileSync(path,'utf8'));
  return {files:files.length,pages:html.length};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) console.log('公開HTML検査成功:',verifySite());
