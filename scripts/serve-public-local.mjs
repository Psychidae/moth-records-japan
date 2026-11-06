import { createServer } from 'node:http';
import { readFileSync,statSync } from 'node:fs';
import { resolve,extname,sep } from 'node:path';
import { securityHeaders } from '../apps/public/src/lib/headers.ts';
const root=resolve('apps/public/dist');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
createServer((req,res)=>{
 try{
  const pathname=decodeURIComponent(new URL(req.url??'/', 'http://127.0.0.1').pathname);
  let path=resolve(root,'.'+pathname);if(path!==root && !path.startsWith(root+sep))throw new Error('Invalid path');
  if(statSync(path).isDirectory())path=resolve(path,'index.html');
  const body=readFileSync(path);res.writeHead(200,{...securityHeaders,'Content-Type':mime[extname(path)]??'application/octet-stream','Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);
 }catch{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8',...securityHeaders});res.end('ページが見つかりません');}
}).listen(4321,'127.0.0.1',()=>console.log('Local review: http://127.0.0.1:4321'));
