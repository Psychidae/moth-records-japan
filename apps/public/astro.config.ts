import { defineConfig } from 'astro/config';
import { securityHeaders } from './src/lib/headers.ts';
export default defineConfig({
  output:'static',
  build:{inlineStylesheets:'never'},
  vite:{build:{assetsInlineLimit:0}},
  server:{headers:securityHeaders},
});
