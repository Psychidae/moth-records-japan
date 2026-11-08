import {constants} from 'node:fs';
import {open,readdir,lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {PHOTO_SIZES,MAX_PHOTO_BYTES,processedPhotoManifestSchema} from '../../../packages/schema/photo-processing.ts';
/** Same O_NOFOLLOW FD for stat/read/stat, with extra-byte and metadata mutation checks. */
export async function readPhotoFile(path:string,maximum:number):Promise<Buffer>{
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>MAX_PHOTO_BYTES)throw Error('Invalid photo byte limit');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await handle.stat({bigint:true});if(!before.isFile()||before.size<1n||before.size>BigInt(maximum))throw Error('Bounded regular photo file required');
  const bytes=Buffer.alloc(Number(before.size));let count=0;
  while(count<bytes.length){const part=await handle.read(bytes,count,bytes.length-count,count);if(!part.bytesRead)break;count+=part.bytesRead;}
  const extra=await handle.read(Buffer.alloc(1),0,1,bytes.length),after=await handle.stat({bigint:true});
  if(count!==bytes.length||extra.bytesRead||before.size!==after.size||before.ino!==after.ino||before.dev!==after.dev||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw Error('Photo artifact changed during bounded read');
  return bytes;
 }finally{await handle.close();}
}
/** Caller must supply its own private job directory, not an arbitrary archive or URL. */
export async function readPhotoArtifacts(directory:string){
 const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory)throw Error('Canonical photo output directory required');
 const wanted=[...PHOTO_SIZES.map(size=>size+'.jpg'),'manifest.json'].sort();
 if(JSON.stringify((await readdir(directory)).sort())!==JSON.stringify(wanted))throw Error('Unexpected photo output');
 const manifest=processedPhotoManifestSchema.parse(JSON.parse((await readPhotoFile(join(directory,'manifest.json'),16384)).toString('utf8')) as unknown);
 const variants=new Map<number,Uint8Array>();for(const size of PHOTO_SIZES)variants.set(size,await readPhotoFile(join(directory,size+'.jpg'),MAX_PHOTO_BYTES));
 return {manifest,variants};
}
