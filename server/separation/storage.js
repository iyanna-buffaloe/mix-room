import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export function createR2Storage(env) {
  const client = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } })
  const Bucket = env.R2_BUCKET_NAME
  return {
    uploadUrl: (Key, size) => getSignedUrl(client, new PutObjectCommand({ Bucket, Key, ContentType: 'audio/wav', ContentLength: size }), { expiresIn: 900 }),
    sourceUrl: Key => getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 86400 }),
    async inspect(Key) {
      const head = await client.send(new HeadObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(10000) })
      const response = await client.send(new GetObjectCommand({ Bucket, Key, Range: 'bytes=0-43' }), { abortSignal: AbortSignal.timeout(10000) })
      return { size: head.ContentLength, header: await response.Body.transformToByteArray() }
    },
  }
}

// The local development server uses the same conditional-write contract as
// Netlify Blobs. Its job files persist across Node restarts and stay outside Git.
export function createLocalStore(directory) {
  let queue = Promise.resolve()
  const filename = key => path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`)
  const read = async key => { try { return JSON.parse(await fs.readFile(filename(key), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
  return {
    getWithMetadata: key => read(key),
    setJSON(key, data, options = {}) {
      const task = queue.then(async () => {
        const current = await read(key)
        if ((options.onlyIfNew && current) || (options.onlyIfMatch && current?.etag !== options.onlyIfMatch)) return { modified: false }
        await fs.mkdir(directory, { recursive: true })
        const etag = randomUUID(), temporary = `${filename(key)}.${etag}.tmp`
        await fs.writeFile(temporary, JSON.stringify({ data, etag }), { mode: 0o600 })
        await fs.rename(temporary, filename(key))
        return { modified: true, etag }
      })
      queue = task.catch(() => {})
      return task
    },
  }
}
