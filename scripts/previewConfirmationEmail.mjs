import { readFile, writeFile } from 'node:fs/promises'

// Every profile shares one offline page; an optional argument selects its first view.
const initial = process.argv[2] ?? 'confirmation'
const profiles = {
  confirmation: { template: 'confirmation', subject: 'Confirm your email address — Mix Room', label: 'Confirmation', note: 'Existing provider-link design.' },
  'reset-password': { template: 'recovery', subject: 'Reset your password — Mix Room', label: 'Password reset', note: 'Existing provider-link design.' },
  'sign-in-otp': { template: 'sign-in-otp', subject: 'Your verification code — Mix Room', label: 'Current-inbox code', note: 'Keep this code version in Magic link or OTP for Verify email.' },
  'email-change': { template: 'email-change', subject: 'Mix Room: Confirm your new email address', label: 'New email address', note: 'New-address confirmation follows the current-inbox code in the website.' },
  reauthentication: { template: 'reauthentication', subject: 'Confirm it’s you — Mix Room', label: 'Password verification code', note: 'Separate from the current-inbox code template.' },
  'confirmation-branded': { template: 'prepared/confirmation-branded', subject: 'Confirm your email address — Mix Room', label: 'Branded confirmation · prepared', note: 'Activate only after the approved public handler works.' },
  'reset-password-branded': { template: 'prepared/recovery-branded', subject: 'Reset your password — Mix Room', label: 'Branded reset · prepared', note: 'Activate with branded confirmation after public checks pass.' },
  invite: { template: 'invite', subject: 'You’re invited to Mix Room', label: 'Invitation · future reference', note: 'A saved design does not enable invitations.' },
  'magic-link': { template: 'magic-link', subject: 'Your sign-in link — Mix Room', label: 'Magic link · future alternative', note: 'Do not replace the code template used by Verify email.' },
}
if (!Object.hasOwn(profiles, initial)) throw new Error(`Choose a profile: ${Object.keys(profiles).join(', ')}`)
const logo = (await readFile(new URL('../public/branding/mix-room-mark.png', import.meta.url))).toString('base64')
const font = (await readFile(new URL('../public/fonts/Jura-Variable.ttf', import.meta.url))).toString('base64')
for (const p of Object.values(profiles)) {
  p.html = (await readFile(new URL(`../supabase/templates/${p.template}.html`, import.meta.url), 'utf8'))
    .replaceAll('{{ .SiteURL }}', 'https://mixroom.example.invalid/')
    .replaceAll('{{ .TokenHash }}', '0'.repeat(56))
    .replaceAll('{{ .ConfirmationURL }}', 'https://project.example.invalid/preview')
    .replaceAll('{{ .Token }}', '123456')
    .replaceAll('{{ .NewEmail }}', 'new-address@example.invalid')
    .replaceAll('https://mixroom.click/branding/mix-room-mark.png', '__PREVIEW_LOGO__')
    .replaceAll('https://mixroom.click/fonts/Jura-Variable.ttf', '__PREVIEW_FONT__')
    // Keep all preview clicks inside the fictional example.
    .replace(/href="[^"]*"/g, 'href="#preview-only"')
  if (/{{\s*\./.test(p.html)) throw new Error(`Unresolved placeholder: ${p.label}`)
}
const json = value => JSON.stringify(value).replaceAll('<', '\\u003c')
const output = new URL('../docs/design/EMAIL_PREVIEWS.html', import.meta.url)
await writeFile(output, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mix Room · account email reference</title><style>
*{box-sizing:border-box}body{margin:0;background:#edf2f6;color:#203448;font:17px/1.55 system-ui,sans-serif}
main{max-width:1320px;margin:auto;padding:28px 24px}nav{font-size:15px}a{color:#155d85}
h1{font-size:32px;line-height:1.2;margin:24px 0 12px}p{max-width:780px}
.controls{display:flex;gap:20px;flex-wrap:wrap;padding:18px;background:white;border:1px solid #c9d5df;border-radius:12px}
label{display:grid;gap:6px;font-weight:600}select{font:inherit;max-width:100%;padding:10px;border:1px solid #9eafbd;border-radius:6px;background:white;color:#203448}
.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin-top:24px}section{min-width:0}h2{font-size:18px}
iframe{display:block;width:100%;max-width:390px;height:800px;margin:auto;border:1px solid #aebfce;border-radius:8px;background:white}
.desktop iframe{max-width:600px}#note{min-height:28px}small{color:#4d6172}
@media(max-width:760px){main{padding:20px 12px}.pair{grid-template-columns:1fr}h1{font-size:27px}select{width:100%}}
</style></head><body><main><nav><a href="../index.html">Reference home</a> · <a href="ACCOUNT_DESIGN.md">Account guide</a></nav>
<h1>Account emails, in one place</h1><p>Choose an email and screen size. Both references use the approved light-template fallback. These local examples use fictional codes. Preview buttons stay in the example and cannot change an account.</p>
<div class="controls"><label>Email<select id="profile">${Object.entries(profiles).map(([key,p]) => `<option value="${key}"${key===initial?' selected':''}>${p.label}</option>`).join('')}</select></label>
<label>Screen size<select id="size"><option value="mobile">Phone · 390 px</option><option value="desktop">Desktop · 600 px</option></select></label></div>
<p><strong>Subject:</strong> <span id="subject"></span></p><p id="note" role="status"></p>
<div id="pair" class="pair"><section><h2>Light appearance</h2><iframe id="light" title="Light email preview" sandbox></iframe></section><section><h2>Dark-mode request · light-template fallback</h2><iframe id="dark" title="Dark email preview" sandbox></iframe></section></div>
<p><small>Assets are embedded for offline use. These references show template CSS, not real inbox rendering. Clients may still recolor messages; use the retained Unspam results and received-email checks. Never paste this preview into Supabase.</small></p></main>
<script>
const profiles=${json(profiles)},assets=${json({logo,font})};
const picker=document.getElementById('profile'),size=document.getElementById('size');
function render(){const p=profiles[picker.value];document.getElementById('subject').textContent=p.subject;document.getElementById('note').textContent=p.note;
const sample=p.html.replaceAll('__PREVIEW_LOGO__','data:image/png;base64,'+assets.logo).replaceAll('__PREVIEW_FONT__','data:font/ttf;base64,'+assets.font);
document.getElementById('light').srcdoc=sample;document.getElementById('dark').srcdoc=sample.replace('<html lang="en"','<html data-ogsc lang="en"');document.getElementById('pair').classList.toggle('desktop',size.value==='desktop');}
function fromHash(){if(Object.hasOwn(profiles,location.hash.slice(1)))picker.value=location.hash.slice(1);render()}
picker.addEventListener('change',()=>{location.hash=picker.value;render()});size.addEventListener('change',render);window.addEventListener('hashchange',fromHash);fromHash();
</script></body></html>\n`)
console.log(`Email reference written to ${output.pathname}#${initial}`)
