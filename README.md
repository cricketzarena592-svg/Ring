# Ring

A lightweight, installable group check-in app built with HTML, CSS, JavaScript modules, and Supabase.

## Run locally

Serve this directory from `localhost` or an HTTPS host. For example:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. In the app, open **Connection settings** and enter your Supabase project URL and anon/publishable key. These values are stored in this browser only. Never use a service-role key in the frontend.

## Supabase setup

1. Create a Supabase project and run [`supabase/schema.sql`](supabase/schema.sql) in the SQL Editor.
2. In **Authentication > URL Configuration**, add the app's local and deployed URLs.
3. Optionally disable email confirmation for a quick local prototype. With confirmation enabled, users must confirm their email before signing in.
4. Sign up with an email, password, and Ring ID. Ring No is generated automatically as a private, non-phone identifier. Share either ID with people you want to invite.

The schema includes row-level security policies, profile creation on signup, and a secure invite RPC. Realtime is enabled for ring events and responses. The app's live updates require a network connection.

## PWA

Install prompts and service workers require `localhost` or HTTPS. The app shell is cached for offline loading; authentication and live Ring actions require Supabase connectivity.