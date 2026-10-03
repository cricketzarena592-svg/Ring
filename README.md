# Ring

A lightweight, installable group check-in app built with HTML, CSS, JavaScript modules, and Supabase.

## Run locally

Serve this directory from `localhost` or an HTTPS host. For example:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. The app connects using the project URL and public publishable key in [`supabase-config.js`](supabase-config.js). The publishable key is browser-visible by design; never put a service-role or secret key in this file.

## Supabase setup

1. Create a Supabase project, update [`supabase-config.js`](supabase-config.js) with its URL and publishable key, and run [`supabase/schema.sql`](supabase/schema.sql) in the SQL Editor.
2. In **Authentication > URL Configuration**, set **Site URL** to your deployed Ring URL and add that exact app URL, plus your local development URL, to **Redirect URLs**. Confirmation links return to the URL currently hosting Ring, which must be allowlisted.
3. Optionally disable email confirmation for a quick local prototype. With confirmation enabled, users must confirm their email before signing in.
4. Sign up with an email, password, and Ring ID. Ring No is generated automatically as a private, non-phone identifier. Share either ID with people you want to invite.

The schema includes row-level security policies, profile creation on signup, and a secure invite RPC. Realtime is enabled for ring events and responses. The app's live updates require a network connection.

## PWA

Install prompts and service workers require `localhost` or HTTPS. The app shell is cached for offline loading; authentication and live Ring actions require Supabase connectivity.