import { createHash } from 'node:crypto';
import { z } from 'zod';
import {PHOTO_SIZES,MAX_PHOTO_BYTES,processedPhotoManifestSchema,photoProcessingClaimSchema,photoHash,immutablePhotoKey,type ProcessedPhotoManifest} from '../../../packages/schema/photo-processing.ts';
export const photoSizes=PHOTO_SIZES;
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const maxBytes=MAX_PHOTO_BYTES;
/** Minimal bounded JPEG structure checker. Decoding only occurs inside the isolated adapter. */
export function inspectJpeg(bytes:Uint8Array,stripRequired=false):{width:number;height:number}{
 if(bytes.length<16||bytes.length>maxBytes||bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217)throw new Error('JPEG required');
 let offset=2,width=0,height=0,scans=0,segments=0;let entropy=false;
 while(offset<bytes.length){
  if(++segments>10000)throw new Error('JPEG segment limit');
  if(entropy){
   while(offset<bytes.length&&bytes[offset]!==255)offset++;
   if(offset>=bytes.length)throw new Error('Incomplete JPEG');
   let cursor=offset+1;while(bytes[cursor]===255)cursor++;const code=bytes[cursor];
   if(code===0||(code!==undefined&&code>=208&&code<=215)){offset=cursor+1;continue;}
   entropy=false;
  }
  if(bytes[offset]!==255)throw new Error('Invalid JPEG marker');
  while(bytes[offset]===255)offset++;const marker=bytes[offset++];if(marker===undefined)throw new Error('Incomplete JPEG');
  if(marker===217){if(offset!==bytes.length||!width||!height||!scans)throw new Error('Incomplete JPEG');return {width,height};}
  if(marker===216||marker===0||(marker>=208&&marker<=215))throw new Error('Invalid JPEG marker');
  if(offset+2>bytes.length)throw new Error('Incomplete JPEG');
  const length=(bytes[offset]!<<8)|bytes[offset+1]!;if(length<2||offset+length>bytes.length)throw new Error('Invalid JPEG segment length');
  if(stripRequired&&((marker>=225&&marker<=239)||marker===254))throw new Error('EXIF/XMP/IPTC/comment metadata forbidden');
  if(stripRequired&&marker===224&&(length!==16||Buffer.from(bytes.subarray(offset+2,offset+7)).toString('ascii')!=='JFIF\0'||bytes[offset+7]!==1||(bytes[offset+8]??255)>2||(bytes[offset+9]??255)>2||bytes[offset+14]!==0||bytes[offset+15]!==0))throw new Error('Noncanonical JFIF metadata forbidden');
  if([192,193,194].includes(marker)){
   if(length<8||width||height||bytes[offset+2]!==8)throw new Error('Invalid JPEG frame');height=(bytes[offset+3]!<<8)|bytes[offset+4]!;width=(bytes[offset+5]!<<8)|bytes[offset+6]!;
   if(!width||!height||width*height>40_000_000||Math.max(width,height)>20000)throw new Error('JPEG pixel limit');
  }else if(marker>=192&&marker<=207&&![196,200,204].includes(marker))throw new Error('Unsupported JPEG frame');
  if(marker===218){if(!width||length<6)throw new Error('Invalid JPEG scan');scans++;entropy=true;}
  offset+=length;
 }
 throw new Error('Incomplete JPEG');
}
export const processedManifestSchema=processedPhotoManifestSchema;
export type ProcessedManifest=ProcessedPhotoManifest;
export interface ProcessingAdapters {
 readonly available:boolean;readonly boundary:'ephemeral-network-none-no-credentials';
 scan:(bytes:Uint8Array)=>Promise<'clean'|'infected'|'error'>;
 normalize:(bytes:Uint8Array,size:typeof photoSizes[number])=>Promise<Uint8Array>;
}
/** Decoder/AV adapters exist only in the unprivileged, credential-free isolation stage. */
export async function processPhoto(bytes:Uint8Array,expectedHash:string,adapters:ProcessingAdapters,enabled=false):Promise<{state:'waiting'}|{state:'processed';manifest:ProcessedManifest;variants:ReadonlyMap<number,Uint8Array>} >{
 if(!enabled||!adapters.available)return {state:'waiting'};
 if(adapters.boundary!=='ephemeral-network-none-no-credentials')throw Error('Photo isolation required');
 photoHash.parse(expectedHash);
 if(bytes.length<1||bytes.length>maxBytes||digest(bytes)!==expectedHash)throw Error('Upload size or checksum mismatch');
 if(Buffer.from(bytes).includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')))throw Error('Malware detected');
 inspectJpeg(bytes);if(await adapters.scan(bytes)!=='clean')throw Error('Malware scan failed');
 const variants=new Map<number,Uint8Array>();const metadata:ProcessedManifest['variants']=[];
 for(const size of photoSizes){
  const output=await adapters.normalize(bytes,size),geometry=inspectJpeg(output,true);
  if(Math.max(geometry.width,geometry.height)>size)throw Error('Variant exceeds size');
  if(await adapters.scan(output)!=='clean')throw Error('Rebuilt malware scan failed');
  variants.set(size,output);metadata.push({size,sha256:digest(output),bytes:output.length,...geometry});
 }
 return {state:'processed',manifest:processedManifestSchema.parse({format:'processed-photo-v2',source_sha256:expectedHash,source_bytes:bytes.length,malware_result:'clean',regeneration:'decode-reencode-stripped',isolation:'network-none-no-credentials',variants:metadata}),variants};
}
export const registrationSchema=photoProcessingClaimSchema;
const planSchema=z.strictObject({format:z.literal('photo-registration-plan-v2'),plan_id:z.uuid(),action:z.enum(['store','waiting','completed']),photo_id:z.string(),generation:z.number().int().nonnegative().safe(),processing_revision:z.number().int().positive().safe(),manifest_sha256:photoHash,expires_at:z.iso.datetime({offset:true}),cleanup_token:z.uuid().nullable()});
const ackSchema=z.strictObject({plan_id:z.uuid(),key:z.string(),sha256:photoHash,bytes:z.number().int().positive().max(maxBytes),immutable:z.literal(true),storage_receipt_id:z.uuid()});
const completionSchema=z.strictObject({state:z.literal('private_ready'),plan_id:z.uuid(),manifest_sha256:photoHash,cleanup_token:z.uuid(),requested_status:z.literal('pending'),review_state:z.literal('unreviewed'),auto_published:z.literal(false),duplicate_suspected:z.boolean()});
export interface RegistrationAdapters {
 /** Transaction must lock canonical upload/queued job/photo/observation and verify authenticated
  * runner journal+reviewed image+source/manifest hashes, active owner, original accepted
  * quota/rights/license/flags, generation/revision and no previous unknown operation.
  * Browser booleans or an isolated manifest alone never establish these facts.
  */
 prepare:(claim:z.infer<typeof registrationSchema>,manifest:ProcessedManifest,manifestHash:string)=>Promise<unknown>;
 current:(planId:string,manifestHash:string)=>Promise<boolean>;
 /** Conditional immutable PUT; retries can only acknowledge an already matching exact object.
  * Store its observed key/SHA/bytes receipt in the private server journal, never trust caller ACK JSON.
  */
 putImmutable:(input:{plan_id:string;key:string;bytes:Uint8Array;sha256:string;content_type:'image/jpeg';if_none_match:'*'})=>Promise<unknown>;
 /** Idempotent server CAS rechecks all current canonical authority and the exact durable storage ACKs. */
 complete:(planId:string,result:{manifest_sha256:string;storage_receipt_ids:readonly string[];requested_status:'pending';review_state:'unreviewed';auto_published:false})=>Promise<unknown>;
 /** Server resolves the original exact quarantine key from this opaque completed plan/cleanup token.
  * Never accepts a key from the sandbox and never deletes a newer generation's source.
  */
 removeQuarantine:(planId:string,cleanupToken:string)=>Promise<void>;
 now?:()=>number;
}
export const photoManifestHash=(manifest:ProcessedManifest)=>digest(Buffer.from(JSON.stringify(processedManifestSchema.parse(manifest))));
export function validatePhotoArtifacts(manifestInput:unknown,variants:ReadonlyMap<number,Uint8Array>,sourceHash:string,sourceBytes:number):ProcessedManifest{
 const manifest=processedManifestSchema.parse(manifestInput);
 if(manifest.source_sha256!==sourceHash||manifest.source_bytes!==sourceBytes||variants.size!==4)throw Error('Processed manifest mismatch');
 for(const record of manifest.variants){const bytes=variants.get(record.size);if(!bytes||bytes.length!==record.bytes||digest(bytes)!==record.sha256)throw Error('Processed checksum mismatch');const geometry=inspectJpeg(bytes,true);if(geometry.width!==record.width||geometry.height!==record.height||Math.max(geometry.width,geometry.height)>record.size)throw Error('Processed geometry mismatch');}
 return manifest;
}
/** Trusted stage has no original reader, decoder, AV executable, public bucket or publication capability.
 * Stale prepare yields PUT0. A later race can leave only new immutable orphan keys; it cannot overwrite
 * the prior generation. A failed/uncertain complete always retains the original and plan fence.
 */
export async function registerProcessedPhoto(context:unknown,manifestInput:unknown,variants:ReadonlyMap<number,Uint8Array>,adapters:RegistrationAdapters,enabled=false):Promise<'waiting'|'ready'|'cleanup_pending'|'uncertain'>{
 if(!enabled)return 'waiting';
 const claim=registrationSchema.parse(context),manifest=validatePhotoArtifacts(manifestInput,variants,claim.source_sha256,claim.source_bytes),manifestHash=photoManifestHash(manifest);
 const plan=planSchema.parse(await adapters.prepare(claim,manifest,manifestHash));
 if(plan.photo_id!==claim.photo_id||plan.generation!==claim.generation||plan.processing_revision!==claim.processing_revision||plan.manifest_sha256!==manifestHash)throw Error('Registration plan mismatch');
 if(plan.action==='waiting')return 'waiting';
 if(plan.action==='completed'){
  if(!plan.cleanup_token)throw Error('Completed receipt required');
  try{await adapters.removeQuarantine(plan.plan_id,plan.cleanup_token);return 'ready';}catch{return 'cleanup_pending';}
 }
 const fresh=()=>Date.parse(plan.expires_at)>(adapters.now??Date.now)();
 const receipts:string[]=[];
 for(const record of manifest.variants){
  if(!fresh()||!await adapters.current(plan.plan_id,manifestHash))throw Error('Photo registration fenced');
  const key=immutablePhotoKey(claim,plan.plan_id,record),ack=ackSchema.parse(await adapters.putImmutable({plan_id:plan.plan_id,key,bytes:variants.get(record.size)!,sha256:record.sha256,content_type:'image/jpeg',if_none_match:'*'}));
  if(ack.plan_id!==plan.plan_id||ack.key!==key||ack.sha256!==record.sha256||ack.bytes!==record.bytes||receipts.includes(ack.storage_receipt_id))throw Error('Private storage not confirmed');receipts.push(ack.storage_receipt_id);
 }
 if(!fresh()||!await adapters.current(plan.plan_id,manifestHash))throw Error('Photo registration fenced');
 let completion:z.infer<typeof completionSchema>;
 try{completion=completionSchema.parse(await adapters.complete(plan.plan_id,{manifest_sha256:manifestHash,storage_receipt_ids:receipts,requested_status:'pending',review_state:'unreviewed',auto_published:false}));if(completion.plan_id!==plan.plan_id||completion.manifest_sha256!==manifestHash)throw Error('Completion receipt mismatch');}catch{return 'uncertain';}
 try{await adapters.removeQuarantine(plan.plan_id,completion.cleanup_token);return 'ready';}catch{return 'cleanup_pending';}
}
