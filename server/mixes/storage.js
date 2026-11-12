import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { MIX_ARCHIVE_TYPE } from '../../shared/savedMix.js'

export function createSavedMixStorage(env) {
  const client = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } })
  // Deliberately no fallback to the temporary separation bucket.
  const Bucket = env.R2_SAVED_MIXES_BUCKET_NAME
  const send = command => client.send(command, { abortSignal: AbortSignal.timeout(30000) })
  return {
    uploadUrl: (Key, bytes) => getSignedUrl(client, new PutObjectCommand({ Bucket, Key, ContentLength: bytes, ContentType: MIX_ARCHIVE_TYPE }), { expiresIn: 900 }),
    downloadUrl: Key => getSignedUrl(client, new GetObjectCommand({ Bucket, Key, ResponseCacheControl: 'private, no-store' }), { expiresIn: 300 }),
    inspect: async Key => {
      const head = await send(new HeadObjectCommand({ Bucket, Key }))
      const first = await send(new GetObjectCommand({ Bucket, Key, Range: 'bytes=0-11' }))
      return { bytes: head.ContentLength, header: await first.Body.transformToByteArray() }
    },
    copy: (from, Key) => send(new CopyObjectCommand({ Bucket, Key, CopySource: `${Bucket}/${from.split('/').map(encodeURIComponent).join('/')}` })),
    remove: Key => send(new DeleteObjectCommand({ Bucket, Key })),
  }
}
