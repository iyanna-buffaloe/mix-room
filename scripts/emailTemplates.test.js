import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { consumeEmailLink } from '../src/auth/emailLink.js'

test('prepared branded email buttons and fallback links contain a supported fragment proof',async()=>{
  for(const [file,kind]of [['confirmation-branded','signup'],['recovery-branded','recovery']]){
    const html=await readFile(new URL(`../supabase/templates/prepared/${file}.html`,import.meta.url),'utf8')
    assert.equal((html.match(/{{ \.TokenHash }}/g)||[]).length,4)
    assert.equal(html.includes('{{ .ConfirmationURL }}'),false)
    const links=[...html.matchAll(/href="([^"]*TokenHash[^"]*)"/g)]
    assert.equal(links.length,3,'Outlook, normal button and fallback agree')
    for(const [,target]of links){
      const url=new URL(target.replaceAll('{{ .SiteURL }}','https://mixroom.click/').replaceAll('{{ .TokenHash }}','a'.repeat(64)).replaceAll('&amp;','&'))
      assert.equal(url.origin,'https://mixroom.click');assert.equal(url.pathname,'/auth/confirm/');assert.equal(url.search,'')
      assert.deepEqual(consumeEmailLink({href:url.href},{replaceState:()=>{}}),{kind,tokenHash:'a'.repeat(64)})
    }
  }
})
test('account landing headers are scoped to its own route and prevent referrer leakage or caching',async()=>{
  const policy=await readFile(new URL('../public/_headers',import.meta.url),'utf8')
  assert.equal(policy.split('\n').filter(line=>line.startsWith('/')).join(''),'/auth/confirm/*')
  for(const required of ['Referrer-Policy: no-referrer','Cache-Control: no-store',"script-src 'self'","form-action 'none'","frame-ancestors 'none'"]){assert.ok(policy.includes(required))}
})
