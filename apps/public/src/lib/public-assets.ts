import { readFileSync,readdirSync,lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const brandAssets=new Map([
  ['actias-aliena-192.png',{size:192,maxBytes:32768,sha256:'0bf90f54cac6e352dcb92d0cd250b8fcb7da18c75e159887b05dbed3545f7e3b'}],
  ['actias-aliena-96.png',{size:96,maxBytes:12288,sha256:'0a99ab75c790e81f158e81346bac458c55fea7680738f63c389102a677fcc44a'}],
  ['actias-aliena-64.png',{size:64,maxBytes:8192,sha256:'94f3d795569a2e4f4286a0e4baa828c9fddd3a0728be18582410027610ab782e'}],
  ['actias-aliena-32.png',{size:32,maxBytes:4096,sha256:'a8ceecc7d813f5aa76f382fc53077ce324da5752ee5272cf00dcc1a60fc27f6f'}],
]);
export function assertBrandPng(data:Buffer,size:number,maxBytes:number):void {
  if(data.length<33 || data.length>maxBytes || !data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || data.toString('ascii',12,16)!=='IHDR' || data.readUInt32BE(16)!==size || data.readUInt32BE(20)!==size || data[24]!==8 || data[25]!==6)throw new Error('Invalid or oversized RGBA brand PNG');
}
export function verifyPublicAssets(root:string):void {
  const allowed=new Map([['_headers','file'],['robots.txt','file'],['data','directory'],['assets','directory']]);
  for(const entry of readdirSync(root,{withFileTypes:true})) {
    if(entry.isSymbolicLink() || lstatSync(join(root,entry.name)).isSymbolicLink() || allowed.get(entry.name)!==(entry.isDirectory()?'directory':entry.isFile()?'file':'other'))throw new Error('Unknown file in public root');
  }
  const directory=join(root,'assets');
  const entries=readdirSync(directory,{withFileTypes:true});
  if(entries.length!==brandAssets.size)throw new Error('Incomplete public brand assets');
  for(const entry of entries){const expected=brandAssets.get(entry.name);if(!expected || !entry.isFile() || entry.isSymbolicLink())throw new Error('Unknown public brand asset');const data=readFileSync(join(directory,entry.name));assertBrandPng(data,expected.size,expected.maxBytes);if(createHash('sha256').update(data).digest('hex')!==expected.sha256)throw new Error('Unapproved brand asset hash');}
}
