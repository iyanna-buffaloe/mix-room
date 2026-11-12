import { createClient } from '@supabase/supabase-js'

function check(result) { if (result.error) throw result.error; return result.data }
export function createMixRepository(env) {
  const client = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  return {
    async verifyToken(token) {
      const { data, error } = await client.auth.getUser(token)
      if (error && (!error.status || error.status >= 500)) throw error
      if (error || !data.user?.email_confirmed_at || data.user.is_anonymous) return null
      return { id: data.user.id }
    },
    list: async owner => check(await client.from('saved_mixes').select('*').eq('owner_id', owner).order('updated_at', { ascending: false })),
    get: async (owner, id) => check(await client.from('saved_mixes').select('*').eq('owner_id', owner).eq('id', id).maybeSingle()),
    getUpload: async (owner, id) => check(await client.from('mix_uploads').select('*').eq('owner_id', owner).eq('id', id).maybeSingle()),
    expiredUploads: async (before, limit = 1000) => check(await client.from('mix_uploads').select('id,owner_id,mix_id,expires_at,committed_at').lt('expires_at', before).order('committed_at', { nullsFirst: true }).order('expires_at').limit(limit)),
    deleteUpload: async (owner, id) => check(await client.from('mix_uploads').delete().eq('owner_id', owner).eq('id', id)),
    beginUpload: async row => check(await client.rpc('reserve_mix_upload', { p_owner: row.owner_id, p_upload: row.id, p_mix: row.mix_id, p_name: row.name, p_bytes: row.bytes, p_expected: row.expected_revision })).at(0),
    commit: async (owner, upload, bytes) => check(await client.rpc('commit_saved_mix', { p_owner: owner, p_upload: upload, p_bytes: bytes })).at(0),
    rename: async (owner, row, name) => check(await client.from('saved_mixes').update({ name, revision: row.revision + 1, updated_at: new Date().toISOString() }).eq('owner_id', owner).eq('id', row.id).eq('revision', row.revision).select().maybeSingle()),
    delete: async (owner, row) => check(await client.from('saved_mixes').delete().eq('owner_id', owner).eq('id', row.id).eq('revision', row.revision).select('id').maybeSingle()),
  }
}
