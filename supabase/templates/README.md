# Account email templates

Ready-to-paste Mix Room HTML for all six Supabase authentication-email categories.

Use the [account-email guide](../../docs/design/ACCOUNT_DESIGN.md) for the exact
Supabase template names, subject lines, light/dark previews, and setup steps.
Magic link and sign-in OTP are alternatives for the same dashboard slot.
**The current Verify email feature requires `sign-in-otp.html` in Magic link or
OTP**, with subject **Your verification code — Mix Room**. This was saved in the
connected project October 22, 2026. Keep `{{ .Token }}` intact. The password nonce
uses the separate Reauthentication template.

Copy the complete `.html` file into Supabase's HTML/source editor. Preserve all
`{{ ... }}` variables. Files named `*-preview.html` are for viewing only.

These files prepare the presentation; they do not enable app features or deploy
the hosted Supabase settings. New features still need their real flow checks.

October 23: confirmation, recovery, email-change and reauthentication bodies
were compared with the connected project's saved HTML and matched. The
reauthentication subject was saved as **Confirm it’s you — Mix Room**. The
current draft serves the public logo successfully. These configuration checks
and generated-token account tests do not prove inbox delivery or rendering.

Later October 23: the change-email body was updated locally and in Supabase
to say **Confirm your new email address to finish the change**. Reloaded saved
HTML matches the local file. Secure email change is off with the user’s approval;
the website verifies a current-inbox code before showing the new-address form.
This replaces the earlier instruction to confirm links from both inboxes.

## Branded confirmation and recovery — prepared, inactive

`prepared/confirmation-branded.html` and `prepared/recovery-branded.html` use the
app's separate `/auth/confirm/` entry. Their button/Outlook/fallback links agree,
use a fragment proof and accept only their intended signup/recovery flow.
The draft handler passes real generated-token tests without SMTP. It supports
this project's 56-character hexadecimal hashes; accepting a link's syntax does
not verify it until Supabase approves the explicit action.

Do not paste these into the live provider yet: they use the fixed `SiteURL`,
which must be `https://mixroom.click/` with the trailing slash. The public
deployment currently lacks the handler. After its approved release, verify the
public route and both real flows, preserve copies of the existing provider
templates, then activate both together. Keep the OTP, reauthentication and
email-change templates unchanged. If rolling the website back to a version
without this route, first restore the old signup/reset templates as well.

Fictional previews: `npm run` is not needed; open
`docs/design/EMAIL_PREVIEWS.html#confirmation-branded` or
`docs/design/EMAIL_PREVIEWS.html#reset-password-branded`. These previews must
never be pasted as live email HTML.
