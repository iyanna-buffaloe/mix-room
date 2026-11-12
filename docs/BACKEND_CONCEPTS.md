# The backend, in everyday language

The backend helps Mix Room remember whose mixes are whose, keep private files
private, and control paid song processing. You do not need to master every
technical term to decide what the app should do.

## What happens when someone saves a mix

1. The browser asks the server to save it.
2. The server checks the person's login and available space.
3. The audio and analysis go to private file storage.
4. The database records the mix name, owner, and file location.
5. The app shows success after the save is complete.

There are two pieces to protect: the record and the actual file. Backing up
only one cannot restore a usable saved mix.

## The services have different jobs

| Service | Plain-language role |
| --- | --- |
| Netlify | Delivers the website and runs short server requests |
| Supabase | Handles accounts and the organized list of mixes |
| Cloudflare R2 | Keeps large audio and mix files |
| Resend | Delivers account emails |
| MVSEP | Separates a whole song into instrument tracks |
| GitHub | Keeps code history and runs development checks |

The browser itself measures uploaded stems, draws the room, plays music, and
exports video. It does not need a Python server for those tasks.

## The terms that affect decisions

**Authentication** asks “Who is signed in?” **Authorization** asks “May this
person open or change this mix?” A hidden button is not enough protection;
the server must check permission too.

A **session** keeps a browser signed in. Its private token proves that login
to the server. A public project key identifies the app and can be in browser
code; a powerful server secret must stay private.

**RLS**, or row level security, is a database rule that limits which records
someone can read. Powerful server keys can bypass those rules, so the server
also checks ownership.

**CORS** tells file storage which website addresses may use it through a browser.
It does not make a private bucket public or replace login checks. A **signed
URL** is a temporary file link; treat it as private while it works.

A **reservation** holds a credit or save place while work runs. An **idempotent**
request can be repeated safely without creating a duplicate. A **revision**
identifies the saved version, helping two tabs avoid overwriting each other.

A **preview** is a test website. It may share the public site's accounts,
storage, and credit records. Its different address does not isolate its data.

## What makes the app dependable

People should keep their old save when an update fails, understand what to do
next, and receive no false success message. Credit checks should survive a
refresh or another device. Cleanup should remove abandoned temporary files
while retaining the files used by saved mixes.

Tests provide different kinds of evidence. Simulations check behavior cheaply.
Real-service checks prove the connected services work together. Received emails,
physical phones, and paid song jobs each need their own evidence.

## What still needs attention

As recorded October 26, the project has working private saves, credit checks,
recovery fixes, and a current test website. Independent production database/audio
backups are not operational. Automatic alert delivery and centralized browser
crash reporting are also absent. Real inbox, phone, paid-song, and final-release
checks remain.

Use the launch checklist for the current tasks,
safe testing before live checks, and
problems and recovery when something fails.
