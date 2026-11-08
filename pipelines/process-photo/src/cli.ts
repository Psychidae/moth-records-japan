import {execFile} from 'node:child_process';
import {mkdir,writeFile,rm,readFile,readdir,lstat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {processPhoto} from './index.ts';
import {readPhotoFile} from './artifacts.ts';
import {assertPhotoIsolation,PHOTO_CHILD_ENVIRONMENT} from './sandbox-plan.ts';
import {MAX_PHOTO_BYTES} from '../../../packages/schema/photo-processing.ts';
function execute(command:'clamscan'|'vipsthumbnail',args:readonly string[]):Promise<{code:number;stdout:string}>{
 return new Promise(resolve=>execFile(command,[...args],{cwd:'/tmp/work',env:PHOTO_CHILD_ENVIRONMENT,encoding:'utf8',timeout:60000,maxBuffer:65536,killSignal:'SIGKILL'},(error,stdout)=>resolve({code:error?typeof error.code==='number'?error.code:2:0,stdout})));
}
/** Only the reviewed image invokes this entrypoint. Imports are inert; no host decoder is run. */
export async function runIsolatedPhotoCli(args:readonly string[]):Promise<void>{
 if(process.platform!=='linux'||process.getuid?.()!==65532||process.cwd()!=='/work')throw Error('Isolated photo Linux runner required');
 const interfaces=(await readFile('/proc/net/dev','utf8')).split('\n').slice(2).map(line=>line.split(':')[0]?.trim()).filter((name):name is string=>Boolean(name));
 const expected=assertPhotoIsolation({platform:process.platform,uid:process.getuid(),gid:process.getgid!(),cwd:process.cwd(),interfaces,status:await readFile('/proc/self/status','utf8'),mounts:await readFile('/proc/self/mountinfo','utf8'),environment:process.env,args});
 const output=await lstat('/out');if(!output.isDirectory()||output.isSymbolicLink()||output.uid!==65532||(output.mode&0o077)!==0||(await readdir('/out')).length)throw Error('Owned empty photo output required');
 const bytes=await readPhotoFile('/in/input.jpg',MAX_PHOTO_BYTES);if(bytes.length!==expected.bytes)throw Error('Photo source byte mismatch');
 await mkdir('/tmp/work',{mode:0o700});
 try{
  await writeFile('/tmp/work/input.jpg',bytes,{flag:'wx',mode:0o600});
  const version=await execute('clamscan',['--version']),vips=await execute('vipsthumbnail',['--version']);
  const age=Date.now()-Date.parse(version.stdout.trim().split('/').at(-1)??'');
  if(version.code!==0||vips.code!==0||!Number.isFinite(age)||age< -3600000||age>48*3600000)throw Error('Current photo engines required');
  let av=0;
  const result=await processPhoto(bytes,expected.sha256,{
   available:true,boundary:'ephemeral-network-none-no-credentials',
   async scan(data){const file=`/tmp/work/av-${++av}.jpg`;await writeFile(file,data,{flag:'wx',mode:0o600});const response=await execute('clamscan',['--no-summary','--follow-dir-symlinks=0','--follow-file-symlinks=0','--max-filesize=11M','--max-scansize=64M','--alert-exceeds-max=yes','--',file]);return response.code===0?'clean':response.code===1?'infected':'error';},
   async normalize(_bytes,size){const file=`/tmp/work/output-${size}.jpg`;if((await execute('vipsthumbnail',['/tmp/work/input.jpg','--size',`${size}x${size}>`,'--output',`${file}[strip,Q=85]`])).code!==0)throw Error('Photo normalization unavailable');return readPhotoFile(file,MAX_PHOTO_BYTES);}
  },true);
  if(result.state!=='processed')throw Error('Photo processing unavailable');
  for(const [size,variant] of result.variants)await writeFile(`/out/${size}.jpg`,variant,{flag:'wx',mode:0o600});
  await writeFile('/out/manifest.json',JSON.stringify(result.manifest)+'\n',{flag:'wx',mode:0o600});
 }finally{await rm('/tmp/work',{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){runIsolatedPhotoCli(process.argv.slice(2)).catch(()=>{process.stderr.write('隔離写真処理を完了できません。成果物を登録しないでください。\n');process.exitCode=1;});}
