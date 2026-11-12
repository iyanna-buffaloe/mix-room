import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const ownerA = '11111111-1111-4111-8111-111111111111', ownerB = '22222222-2222-4222-8222-222222222222'
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('Postgres enforces private reads, server-only writes, three places, and idempotent concurrent saves', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
      insert into auth.users values ('${ownerA}'), ('${ownerB}');`)
    await db.exec(await readFile(new URL('../../supabase/migrations/20261019184955_create_private_mix_library.sql', import.meta.url), 'utf8'))
    await db.exec('set role service_role;')
    const reserve = (upload, mix, expected = null, owner = ownerA) => db.query('select * from public.reserve_mix_upload($1, $2, $3, $4, $5, $6)', [owner, upload, mix, 'Night drive', 1000, expected])
    const commit = (upload, owner = ownerA) => db.query('select * from public.commit_saved_mix($1, $2, $3)', [owner, upload, 1000])
    // Three reservations can be outstanding; a fourth is rejected before upload.
    await Promise.all([1, 2, 3].map(n => reserve(uuid(n), uuid(n + 10))))
    await assert.rejects(reserve(uuid(4), uuid(14)), /UPLOAD_LIMIT/)
    const results = await Promise.all([1, 2, 3].map(n => commit(uuid(n))))
    assert.equal(results.length, 3)
    await reserve(uuid(4), uuid(14))
    await assert.rejects(commit(uuid(4)), /MIX_LIMIT/)
    assert.equal((await db.query('select * from public.saved_mixes where owner_id = $1', [ownerA])).rows.length, 3)
    assert.equal((await commit(uuid(1))).rows[0].id, uuid(11))
    assert.equal((await commit(uuid(1))).rows[0].revision, 1)
    await reserve(uuid(5), uuid(11), 1)
    const replacement = (await commit(uuid(5))).rows[0]
    assert.equal(replacement.id, uuid(11)); assert.equal(replacement.revision, 2)
    await assert.rejects(commit(uuid(1)), /MIX_CHANGED/)
    await reserve(uuid(6), uuid(11), 1)
    await assert.rejects(commit(uuid(6)), /MIX_CHANGED/)
    // Supplying another owner's ID must never overwrite their record.
    await reserve(uuid(7), uuid(11), null, ownerB)
    await assert.rejects(commit(uuid(7), ownerB), /MIX_CHANGED/)
    await db.exec(`reset role; set role authenticated; set request.jwt.claim.sub = '${ownerB}';`)
    assert.equal((await db.query('select * from public.saved_mixes')).rows.length, 0)
    await assert.rejects(commit(uuid(1)), /permission denied/)
    await assert.rejects(db.query("update public.saved_mixes set name = 'stolen'"), /permission denied/)
    await assert.rejects(db.query('select * from public.mix_uploads'), /permission denied/)
    await db.exec(`set request.jwt.claim.sub = '${ownerA}';`)
    assert.equal((await db.query('select * from public.saved_mixes')).rows.length, 3)
    await db.exec('reset role; set role anon;')
    await assert.rejects(db.query('select * from public.saved_mixes'), /permission denied/)
  } finally { await db.close() }
})

test('database byte limits permit exactly three 160 MiB mixes and reject an oversized reservation', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
      insert into auth.users values ('${ownerA}');`)
    await db.exec(await readFile(new URL('../../supabase/migrations/20261019184955_create_private_mix_library.sql', import.meta.url), 'utf8'))
    await db.exec('set role service_role')
    const bytes = 160 * 1024 * 1024
    await assert.rejects(db.query('select * from reserve_mix_upload($1,$2,$3,$4,$5,null)', [ownerA, uuid(1), uuid(11), 'Too large', bytes + 1]), /check constraint/)
    for (let n = 1; n <= 3; n++) {
      await db.query('select * from reserve_mix_upload($1,$2,$3,$4,$5,null)', [ownerA, uuid(n), uuid(n+10), 'At the limit', bytes])
      await db.query('select * from commit_saved_mix($1,$2,$3)', [ownerA, uuid(n), bytes])
    }
    const total = (await db.query('select sum(bytes)::bigint as bytes from saved_mixes')).rows[0].bytes
    assert.equal(Number(total), 480 * 1024 * 1024)
    await db.query('select * from reserve_mix_upload($1,$2,$3,$4,$5,$6)', [ownerA, uuid(4), uuid(11), 'Replacement at the limit', bytes, 1])
    const replaced = (await db.query('select * from commit_saved_mix($1,$2,$3)', [ownerA, uuid(4), bytes])).rows[0]
    assert.equal(replaced.revision, 2)
    assert.equal(Number((await db.query('select sum(bytes)::bigint as bytes from saved_mixes')).rows[0].bytes), total)
  } finally { await db.close() }
})
