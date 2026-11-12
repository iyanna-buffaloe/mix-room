# Account screens and emails

Keep each screen focused on one clear action. Show short feedback that explains
what happened and what to do next. Account rules
define the behavior; this page holds the screen and email reference.

## Screens

Sign in/Account stays in the top-right header. My mixes is its own workspace
panel. Signed-in Account shows settings beside the live room on wide screens;
phones use the space for readable forms. Sign-in, signup, and recovery use
focused dialogs. Opening them keeps the original music tab alive.

| Screen | Main action | Helpful secondary path |
| --- | --- | --- |
| Sign in | Sign in | Forgot password; Create account |
| Signup | Create account | Sign in |
| Email requested | Back to sign in | Resend after cooldown; change address; delivery help |
| Invalid link | Back to sign in | Request another link |
| Reset | Update password | Show/Hide; clear password requirement |
| Account | Edit account details | My mixes; Sign out |

Keep email across form switches; clear passwords/codes on close or success.
Allow paste/autofill and spaces. Use neutral email-request feedback. Verification
help appears when needed, rather than filling the initial sign-in screen.

Focus stays inside a dialog; Escape/close returns it to the opener. Errors receive
focus. Phone inputs use at least 16 px text and controls stay reachable above
the keyboard. Short windows must scroll complete fields, not merely expose part.

Email changes start with Verify email, unlock for five minutes, then require only
the new-address confirmation. Password changes send the current password and
use an extra code when the provider requires it. See M13–M15 in
the hands-on checks.

## Email source and preview catalog

Templates share a wordless logo, Jura brand text, Arial body, navy/white light
colors. The November 4 candidate uses the approved light-template fallback in
both requested color schemes; recipient apps can still recolor it. They remain
usable when images are blocked. Keep placeholders intact and paste source HTML,
not previews.

| Template | Source / subject | Preview |
| --- | --- | --- |
| Confirm sign up | [confirmation.html](../../supabase/templates/confirmation.html) · Confirm your email address — Mix Room | [View](EMAIL_PREVIEWS.html#confirmation) |
| Reset password | [recovery.html](../../supabase/templates/recovery.html) · Reset your password — Mix Room | [View](EMAIL_PREVIEWS.html#reset-password) |
| Invite user | [invite.html](../../supabase/templates/invite.html) · You’re invited to Mix Room | [View](EMAIL_PREVIEWS.html#invite) |
| Magic link | [magic-link.html](../../supabase/templates/magic-link.html) · Your sign-in link — Mix Room | [View](EMAIL_PREVIEWS.html#magic-link) |
| Magic link or OTP: current code version | [sign-in-otp.html](../../supabase/templates/sign-in-otp.html) · Your verification code — Mix Room | [View](EMAIL_PREVIEWS.html#sign-in-otp) |
| Change email | [email-change.html](../../supabase/templates/email-change.html) · Saved subject: Mix Room: Confirm your new email address | [View](EMAIL_PREVIEWS.html#email-change) |
| Reauthentication | [reauthentication.html](../../supabase/templates/reauthentication.html) · Confirm it’s you — Mix Room | [View](EMAIL_PREVIEWS.html#reauthentication) |

Magic link and OTP are alternatives in one dashboard slot. Keep the code version
for Verify email. Prepared invitation/passwordless designs do not enable those
features. The reauthentication code belongs to a different template slot.

All email previews now share one HTML page. Regenerate it with `node scripts/previewConfirmationEmail.mjs`, optionally
followed by `reset-password`, `invite`, `magic-link`, `sign-in-otp`, `email-change`,
or `reauthentication`.

## Hosted state and remaining checks

October 23 verified saved confirmation/recovery/change/reauthentication bodies
and Resend SMTP. The email-change wording was then updated for new-address-only
confirmation. Older screenshots can show the earlier wording.

Branded confirmation/reset alternatives are prepared and tested on the preview;
activation waits for the public handler and release. Follow email setup
and [template release notes](../../supabase/templates/README.md).

Earlier browser checks used four widths, light/dark and Outlook-selector
simulations, font fallback, blocked images, long links, and 44 px buttons.
Minimum checked contrast was 5.15:1. Those checks do not reproduce every inbox
client. Fresh Outlook iPhone/Gmail/Apple Mail/Windows Outlook and real delivery
remain hands-on checks. The public logo must load after release.

November 4: a synthetic [Unspam baseline](https://unspam.email/client-preview/9031d947-45a4-4e78-b831-383301e30782)
reproduced the reported Outlook dark-mode recoloring. The earlier preview
generator suppressed native dark-mode CSS, so its simulated Outlook selectors
were not evidence of the actual client result. The fallback candidate passed
72 local rendering cases and preserved light screenshots, content, action links
and proof placeholders. Unspam's free-preview limit blocked a final client
render; independent client verification remains open. No provider template was
published. The catalog distinguishes local CSS references from actual inboxes.
