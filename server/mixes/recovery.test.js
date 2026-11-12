import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createMixArchive, readMixArchive } from '../../src/audio/mixArchive.js'
import { encodeSeparationWav } from '../../shared/separationAudio.js'

// An offline restore rehearsal, not a production backup/restore command.
// No service credentials, user files, network or production SQL are used.
test('paired database and audio backup restores the committed mix, ownership and playback bytes',async()=>{
  const source=new PGlite(), owner=randomUUID(), outsider=randomUUID(), upload=randomUUID(), mix=randomUUID()
  let restored
  try{
    await source.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`)
    await source.query('insert into auth.users values($1),($2)',[owner,outsider])
    await source.exec(await readFile(new URL('../../supabase/migrations/20261019184955_create_private_mix_library.sql',import.meta.url),'utf8'))
    const audio=new Blob([encodeSeparationWav(Float32Array.from({length:4410},(_,n)=>Math.sin(n*.1)*.05))],{type:'audio/wav'})
    const archive=createMixArchive({version:1,id:mix,metadata:{title:'Restore rehearsal',duration:.1,processingMode:'stems',instruments:[{key:'tone',label:'Tone',freq:.4}]},framesByKey:{tone:[{t:0,loud:.5,pan:-.3}]},audioBlob:audio},{visibility:{tone:false},settings:{roomStyle:'dark'}})
    await source.exec('set role service_role')
    await source.query('select * from reserve_mix_upload($1,$2,$3,$4,$5,null)',[owner,upload,mix,'Restore rehearsal',archive.size])
    const row=(await source.query('select * from commit_saved_mix($1,$2,$3)',[owner,upload,archive.size])).rows[0]
    const files=new Map([[row.object_key,archive]])
    // These two independently stored parts form one recovery set.
    const databaseBackup=await source.dumpDataDir()
    const audioBackup=new Map(files)
    const hash=async blob=>createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex')
    const manifest={mix:row.id,owner:row.owner_id,object:row.object_key,bytes:archive.size,sha256:await hash(archive)}
    await source.query('delete from saved_mixes where id=$1',[mix]);files.clear()
    assert.equal((await source.query('select * from saved_mixes')).rows.length,0)
    assert.equal(files.size,0)
    restored=new PGlite({loadDataDir:databaseBackup})
    const recovered=(await restored.query('select * from saved_mixes where id=$1',[mix])).rows[0]
    assert.equal(recovered.object_key,manifest.object);assert.equal(recovered.owner_id,manifest.owner)
    assert.equal(recovered.revision,row.revision)
    assert.equal(files.has(recovered.object_key),false,'A database-only restore cannot supply missing audio')
    const restoredArchive=audioBackup.get(recovered.object_key)
    assert.equal(restoredArchive.size,Number(recovered.bytes))
    assert.equal(await hash(restoredArchive),manifest.sha256)
    const decoded=await readMixArchive(restoredArchive)
    assert.equal(await hash(decoded.record.audioBlob),await hash(audio))
    assert.equal(decoded.record.metadata.title,'Restore rehearsal')
    assert.deepEqual(decoded.record.framesByKey.tone,[{t:0,loud:.5,pan:-.3}])
    assert.equal(decoded.view.visibility.tone,false);assert.equal(decoded.view.settings.roomStyle,'dark')
    const corrupt=new Blob([await restoredArchive.slice(0,restoredArchive.size-1).arrayBuffer(),new Uint8Array([255])])
    assert.notEqual(await hash(corrupt),manifest.sha256,'Size alone cannot establish a good backup')
    await restored.exec(`reset role;set role authenticated;set request.jwt.claim.sub='${outsider}'`)
    assert.equal((await restored.query('select * from saved_mixes')).rows.length,0)
    await restored.exec(`set request.jwt.claim.sub='${owner}'`)
    assert.equal((await restored.query('select * from saved_mixes')).rows.length,1)
    await assert.rejects(restored.query('delete from saved_mixes where id=$1',[mix]),/permission denied/)
  }finally{await restored?.close();await source.close()}
})
