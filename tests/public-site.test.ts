import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,expect,it } from 'vitest';
import { cloudflareHeaders,securityHeaders } from '../apps/public/src/lib/headers.ts';
import { latestVersion, readPublicJson } from '../apps/public/src/lib/data.ts';
import { assertSafeHtml } from '../scripts/verify-public-site.ts';
import { formatJapanTime } from '../apps/public/src/lib/date.ts';
describe('static public site safety',()=>{
  it('shows Japanese local dates across the UTC day boundary while retaining machine dates separately',()=>{
    expect(formatJapanTime('2026-11-05T23:47:40Z')).toBe('2026/11/06 08:47:40 日本時間');
    expect(formatJapanTime('2026-12-31T15:00:00Z')).toBe('2027/01/01 00:00:00 日本時間');
    expect(()=>formatJapanTime('invalid')).toThrow();
  });
  it('rejects inline runtime, styles, event attributes and remote scripts in generated HTML',()=>{
    for(const html of ['<script>console.log(1)</script>','<style>p{color:red}</style>','<p style="color:red">a</p>','<button onclick="x()">a</button>','<script src="https://example.invalid/a.js"></script>','<script src="//example.invalid/a.js"></script>']) expect(()=>assertSafeHtml(html)).toThrow();
    expect(()=>assertSafeHtml('<link rel="stylesheet" href="/_astro/a.css"><script type="module" src="/_astro/a.js"></script>')).not.toThrow();
  });
  it('applies the strict policy to all paths, without inline or remote script/style permissions',()=>{
    expect(cloudflareHeaders.startsWith('/*\n')).toBe(true);
    expect(Object.keys(securityHeaders)).toHaveLength(6);
    expect(securityHeaders['Content-Security-Policy']).toContain("script-src 'self'; style-src 'self'");
    expect(cloudflareHeaders).not.toMatch(/unsafe-inline|unsafe-eval|script-src[^;]+https:/);
    expect(securityHeaders['Permissions-Policy']).toContain('geolocation=()');
    expect(securityHeaders['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
  });
  it('fails without an artifact and rejects paths outside the public version',()=>{
    const root=mkdtempSync(join(tmpdir(),'moth-site-empty-'));
    try{expect(()=>latestVersion(root)).toThrow('Verified public artifact');}finally{rmSync(root,{recursive:true,force:true});}
    for(const path of ['../private.json','/etc/passwd','records/../../private']) expect(()=>readPublicJson(path)).toThrow('Invalid public data path');
  });
  it('does not let production or generic CI silently generate development data',()=>{
    const source=readFileSync('scripts/prepare-public-site.ts','utf8');
    expect(source).toContain("process.env.MOTH_PUBLIC_BOOTSTRAP!=='1'");
    expect(source).not.toMatch(/process\.env\.(?:CI|NODE_ENV)/);
    expect(source).toContain("'--seed'");
    expect(source).not.toContain("'--run'");
  });
});
