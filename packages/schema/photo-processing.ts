import {z} from 'zod';
export const PHOTO_SIZES=[2048,1024,500,240] as const;
export const LEGACY_PHOTO_SIZES=[2048,800,320] as const;
export const MAX_PHOTO_BYTES=10*1024*1024;
export const photoHash=z.string().regex(/^[a-f0-9]{64}$/);
export const photoNumber=z.string().regex(/^[1-9]\d{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n);
export const photoCode=z.string().regex(/^PH\d{7,12}$/);
export const photoSize=z.union([z.literal(2048),z.literal(1024),z.literal(500),z.literal(240)]);
export const photoVariantSchema=z.strictObject({size:photoSize,sha256:photoHash,bytes:z.number().int().positive().max(MAX_PHOTO_BYTES),width:z.number().int().positive().max(2048),height:z.number().int().positive().max(2048)}).refine(value=>Math.max(value.width,value.height)<=value.size);
export const processedPhotoManifestSchema=z.strictObject({format:z.literal('processed-photo-v2'),source_sha256:photoHash,source_bytes:z.number().int().positive().max(MAX_PHOTO_BYTES),malware_result:z.literal('clean'),regeneration:z.literal('decode-reencode-stripped'),isolation:z.literal('network-none-no-credentials'),variants:z.array(photoVariantSchema).length(4).refine(values=>PHOTO_SIZES.every(size=>values.filter(value=>value.size===size).length===1))});
export type ProcessedPhotoManifest=z.infer<typeof processedPhotoManifestSchema>;
export const photoProcessingClaimSchema=z.strictObject({format:z.literal('photo-processing-claim-v2'),processor_image:z.string().regex(/^ghcr\.io\/psychidae\/moth-photo-processor@sha256:[a-f0-9]{64}$/),job_id:z.uuid(),actor_id:z.uuid(),intent_id:z.uuid(),photo_id:photoNumber,observation_code:photoCode,position:z.number().int().min(1).max(4),source_sha256:photoHash,source_bytes:z.number().int().positive().max(MAX_PHOTO_BYTES),generation:z.number().int().nonnegative().safe(),processing_revision:z.number().int().positive().safe(),runner_receipt_id:z.uuid(),reserved_at:z.iso.datetime({offset:true}),upload_expires_at:z.iso.datetime({offset:true})}).refine(value=>Date.parse(value.upload_expires_at)-Date.parse(value.reserved_at)===900000);
export type PhotoProcessingClaim=z.infer<typeof photoProcessingClaimSchema>;
export function immutablePhotoKey(claim:PhotoProcessingClaim,planId:string,variant:z.infer<typeof photoVariantSchema>):string{
 photoProcessingClaimSchema.parse(claim);z.uuid().parse(planId);photoVariantSchema.parse(variant);
 return `photos/${claim.observation_code}/g${claim.generation}/${planId}/${claim.position}-${variant.size}-${variant.sha256}.jpg`;
}
export const immutablePhotoKeySchema=z.string().regex(/^photos\/PH\d{7,12}\/g\d{1,16}\/[a-f0-9-]{36}\/[1-4]-(?:2048|1024|500|240)-[a-f0-9]{64}\.jpg$/);
