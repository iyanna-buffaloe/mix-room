import test from 'node:test'
import assert from 'node:assert/strict'
import { accountCallback, accountConfig, assertPublicAccountEnvironment } from './accountConfig.js'

test('only public publishable configuration can create a browser client', () => {
  const env = { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' }
  assert.deepEqual(accountConfig(env), { url: env.VITE_SUPABASE_URL, key: env.VITE_SUPABASE_PUBLISHABLE_KEY })
  for (const key of ['', 'sb_secret_example', 'service_role', 'eyJhbGciOiJIUzI1NiJ9']) assert.equal(accountConfig({ ...env, VITE_SUPABASE_PUBLISHABLE_KEY: key }), null)
  for (const url of ['http://example.com', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/?secret=1']) assert.equal(accountConfig({ ...env, VITE_SUPABASE_URL: url }), null)
  assert.equal(accountConfig({ ...env, VITE_SUPABASE_URL: 'http://localhost:54321' }).url, 'http://localhost:54321')
  assert.equal(accountConfig({}), null)
})

test('build configuration rejects public-prefixed secrets before browser transformation', () => {
  const env = { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' }
  assert.doesNotThrow(() => assertPublicAccountEnvironment(env))
  assert.doesNotThrow(() => assertPublicAccountEnvironment({}))
  assert.throws(() => assertPublicAccountEnvironment({ ...env, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_private' }), /must never be browser/)
  assert.throws(() => assertPublicAccountEnvironment({ ...env, VITE_R2_SECRET_ACCESS_KEY: 'private' }), /server credentials/)
})

test('confirmation cleanup removes credentials while keeping app navigation', () => {
  const callback = accountCallback('https://mix.example/?dev=1#access_token=private&refresh_token=private2&expires_in=3600&type=signup')
  assert.deepEqual(callback, { present: true, failed: false, cleanUrl: '/?dev=1' })
  assert.deepEqual(accountCallback('https://mix.example/?code=private&view=room'), { present: true, failed: false, cleanUrl: '/?view=room' })
  assert.deepEqual(accountCallback('https://mix.example/#error=access_denied&error_code=otp_expired&error_description=private'), { present: true, failed: true, cleanUrl: '/' })
  assert.equal(accountCallback('https://mix.example/#room').cleanUrl, '/#room')
})

test('callback cleanup removes all credential fields from both query and hash', () => {
  const value = accountCallback('https://mix.example/?code=private&access_token=private&refresh_token=private&type=signup&expires_in=30&expires_at=60&token_type=bearer&error_description=private&view=room#access_token=private&refresh_token=private&code=private&error_code=private&type=recovery&expires_in=30&expires_at=60&token_type=bearer&keep=yes')
  assert.equal(value.cleanUrl, '/?view=room#keep=yes')
  assert.equal(value.recovery, true)
  assert.equal(value.failed, true)
})

test('invalid public configuration errors never include credential values', () => {
  for (const env of [
    { VITE_SUPABASE_URL: 'https://example.supabase.co' },
    { VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' },
    { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_do_not_expose' },
    { VITE_PRIVATE_SETTING: 'do_not_expose' },
  ]) assert.throws(() => assertPublicAccountEnvironment(env), error => !error.message.includes('do_not_expose'))
})
