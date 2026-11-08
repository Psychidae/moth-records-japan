import {z} from 'zod';
import {MAX_PHOTO_BYTES,photoHash} from '../../../packages/schema/photo-processing.ts';
export const photoProcessorImage=z.string().regex(/^ghcr\.io\/psychidae\/moth-photo-processor@sha256:[a-f0-9]{64}$/);
export const PHOTO_CHILD_ENVIRONMENT=Object.freeze({PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',HOME:'/tmp/empty',TMPDIR:'/tmp/work',VIPS_CONCURRENCY:'1',VIPS_DISC_THRESHOLD:'64m'});
export function photoSandboxPlan(input:unknown):{command:'docker';args:readonly string[];environment:Readonly<Record<string,string>>}|null{
 if(z.object({enabled:z.boolean().optional()}).passthrough().parse(input).enabled!==true)return null;
 const value=z.strictObject({enabled:z.literal(true),image:photoProcessorImage,input_file:z.string().regex(/^\/tmp\/moth-photo-job-[a-f0-9]{32}\/input\.jpg$/),output_directory:z.string().regex(/^\/tmp\/moth-photo-job-[a-f0-9]{32}\/derived$/),source_sha256:photoHash,bytes:z.number().int().positive().max(MAX_PHOTO_BYTES)}).parse(input);
 if(value.input_file.slice(0,-10)!==value.output_directory.slice(0,-8))throw Error('One owned photo job directory required');
 return {command:'docker',args:['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','1g','--cpus','1','--user','65532:65532','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=256m',...Object.entries(PHOTO_CHILD_ENVIRONMENT).flatMap(([key,value])=>['--env',key+'='+value]),'--mount',`type=bind,src=${value.input_file},dst=/in/input.jpg,readonly`,'--mount',`type=bind,src=${value.output_directory},dst=/out`,'--workdir','/work',value.image,'node','--experimental-strip-types','/work/pipelines/process-photo/src/cli.ts','/in/input.jpg','/out',value.source_sha256,String(value.bytes)],environment:Object.freeze({PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'})};
}
/** Pure runtime guard for the fixed image CLI; host-owned namespace launch remains mandatory. */
export function assertPhotoIsolation(facts:{platform:string;uid:number;gid:number;cwd:string;interfaces:readonly string[];status:string;mounts:string;environment:Readonly<Record<string,string|undefined>>;args:readonly string[]}):{sha256:string;bytes:number}{
 if(facts.platform!=='linux'||facts.uid!==65532||facts.gid!==65532||facts.cwd!=='/work'||!facts.interfaces.includes('lo')||facts.interfaces.some(name=>name!=='lo')||!['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].every(name=>new RegExp('^'+name+':\\s+0+$','m').test(facts.status))||!/^NoNewPrivs:\s+1$/m.test(facts.status))throw Error('Photo Linux namespace isolation required');
 const mounts=facts.mounts.split('\n').filter(Boolean).map(line=>line.split(' '));
 const mounted=(path:string,mode:string)=>mounts.some(parts=>parts[4]===path&&parts[5]?.split(',').includes(mode));
 if(!mounted('/','ro')||!mounted('/in/input.jpg','ro')||!mounted('/out','rw')||mounts.some(parts=>parts[4]==='/work'))throw Error('Photo readonly mount isolation required');
 const allowed=new Set([...Object.keys(PHOTO_CHILD_ENVIRONMENT),'HOSTNAME','PWD']);
 if(Object.keys(facts.environment).some(key=>!allowed.has(key))||Object.entries(PHOTO_CHILD_ENVIRONMENT).some(([key,value])=>facts.environment[key]!==value)||facts.environment.PWD!==undefined&&facts.environment.PWD!=='/work')throw Error('Credential-free fixed environment required');
 if(facts.args.length!==4||facts.args[0]!=='/in/input.jpg'||facts.args[1]!=='/out')throw Error('Fixed photo argv required');
 return {sha256:photoHash.parse(facts.args[2]),bytes:z.coerce.number().int().positive().max(MAX_PHOTO_BYTES).parse(facts.args[3])};
}
