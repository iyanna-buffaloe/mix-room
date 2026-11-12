import pg from 'pg'
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getStore } from '@netlify/blobs'
import { writeFile } from 'node:fs/promises'
import { creditKey, fail } from './core.mjs'

// All remote adapters are read-only. There is deliberately no provider submission,
// R2 mutation, Auth administration, or credit-store mutation in this module.
export function sources(config, secrets, command) {
  const pgEnv = { PGHOST: config.databaseHost, PGPORT: '5432', PGDATABASE: 'postgres',
    PGUSER: `postgres.${config.project}`, PGPASSWORD: secrets.database, PGSSLMODE: 'verify-full',
    PGCONNECT_TIMEOUT: '20', PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=600000' }
  const database = {
    async open() {
      const client = new pg.Client({ host: pgEnv.PGHOST, port: 5432, database: 'postgres', user: pgEnv.PGUSER,
        password: secrets.database, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 20000,
        query_timeout: 600000, application_name: 'mix-room-read-only-backup' })
      client.on('error', () => {})
      try {
        await client.connect()
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await client.query("SET LOCAL statement_timeout = '10min'")
        const { rows: [{ snapshot }] } = await client.query('SELECT pg_export_snapshot() AS snapshot')
        if (!/^[0-9A-Fa-f-]+$/.test(snapshot)) throw fail('INVALID_DATABASE_SNAPSHOT')
        const { rows } = await client.query('SELECT id, owner_id, object_id, object_key, name, bytes, revision, updated_at FROM public.saved_mixes ORDER BY id')
        return { rows,
          dump: file => command(config.pgDump, ['--no-password', '--format=custom', '--compress=0', '--no-owner',
            '--schema=public', '--schema=auth', '--schema=supabase_migrations',
            '--exclude-table-data=auth.sessions', '--exclude-table-data=auth.refresh_tokens',
            '--snapshot=' + snapshot, '--file=' + file], { env: pgEnv, code: 'DATABASE_EXPORT_FAILED' }),
          // Global roles are configuration, not in the transaction snapshot; custom role passwords stay private.
          roles: async file => {
            const text = await command(config.pgDumpAll, ['--no-password', '--roles-only', '--no-role-passwords'], { env: pgEnv, code: 'DATABASE_ROLES_FAILED' })
            if (!text.includes('PostgreSQL')) throw fail('DATABASE_ROLES_FAILED')
            await writeFile(file, text, { mode: 0o600 })
          },
          close: async () => { await client.query('ROLLBACK').catch(() => {}); await client.end() },
        }
      } catch {
        await client.end().catch(() => {})
        throw fail('DATABASE_CONNECTION_FAILED')
      }
    },
  }
  const s3 = new S3Client({ endpoint: `https://${config.r2Account}.r2.cloudflarestorage.com`, region: 'auto',
    credentials: { accessKeyId: secrets.r2Access, secretAccessKey: secrets.r2Secret }, maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' })
  const send = command => s3.send(command, { abortSignal: AbortSignal.timeout(120000) })
  const objects = {
    head: async Key => { const r = await send(new HeadObjectCommand({ Bucket: config.savedBucket, Key })); return { bytes: r.ContentLength, etag: r.ETag } },
    get: async (Key, IfMatch) => (await send(new GetObjectCommand({ Bucket: config.savedBucket, Key, IfMatch }))).Body,
  }
  const store = getStore({ name: 'mix-room-separation', siteID: config.siteID, token: secrets.netlify, consistency: 'strong',
    fetch: (input, options = {}) => fetch(input, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }) })
  const credits = { async read() {
    const entries = []
    for await (const page of store.list({ paginate: true })) {
      for (const { key } of page.blobs) {
        if (!creditKey(key) || entries.length >= 100000) throw fail('UNKNOWN_CREDIT_RECORD')
        const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' })
        if (!entry) throw fail('CREDITS_CHANGED_RETRY')
        entries.push({ key, data: entry.data, metadata: entry.metadata ?? {} })
      }
    }
    return entries.sort((a, b) => a.key.localeCompare(b.key))
  } }
  return { database, objects, credits }
}
