# Ring

A lightweight, installable group check-in app built with HTML, CSS, JavaScript modules, and Supabase.

## Run locally

Serve this directory from `localhost` or an HTTPS host. For example:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. The app connects using the project URL and public publishable key in [`supabase-config.js`](supabase-config.js). The publishable key is browser-visible by design; never put a service-role or secret key in this file.

## Supabase setup

1. Create a Supabase project, update [`supabase-config.js`](supabase-config.js) with its URL and publishable key, and run [`supabase/schema.sql`](supabase/schema.sql) in the SQL Editor. Re-run the schema after updating Ring to add the push subscription table.
2. In **Authentication > URL Configuration**, set **Site URL** to your deployed Ring URL and add that exact app URL, plus your local development URL, to **Redirect URLs**. Confirmation links return to the URL currently hosting Ring, which must be allowlisted.
3. Optionally disable email confirmation for a quick local prototype. With confirmation enabled, users must confirm their email before signing in.
4. Sign up with an email, password, and Ring ID. Ring No is generated automatically as a private, non-phone identifier. Share either ID with people you want to invite.

The schema includes row-level security policies, profile creation on signup, and a secure invite RPC. Realtime is enabled for ring events and responses. The app's live updates require a network connection.

Ring creators can delete their own Rings from the Ring options menu. Deletion is permanent and removes the Ring's members, check-ins, and responses.

## Install and notifications

Install and push notifications require `localhost` for development or HTTPS when deployed. On iPhone or iPad, open Ring in Safari, tap **Share**, then **Add to Home Screen**. On Android, use Chrome's menu and choose **Install app** or **Add to Home screen**. Ring also has an install button with device-specific instructions.

Incoming Rings can notify members when Ring is closed. To configure Web Push:

1. Generate a VAPID key pair with `npx web-push generate-vapid-keys`.
2. Put the public key in `VAPID_PUBLIC_KEY` in [`supabase-config.js`](supabase-config.js). Keep the private key out of the app and repository.
3. Link the Supabase CLI to your project and set its server-side secrets (use the key pair from step 1 and a contact email):

   ```sh
   supabase link --project-ref <project-ref>
   supabase secrets set VAPID_PUBLIC_KEY="<public-key>" VAPID_PRIVATE_KEY="<private-key>" VAPID_SUBJECT="mailto:you@example.com"
   ```

4. Deploy the push sender function:

   ```sh
   supabase functions deploy send-ring-notification
   ```

5. In Ring, open your profile and enable **Ring notifications** on each device. The browser will ask permission. Tapping a notification opens the active incoming Ring screen; mobile browsers do not allow a website to force that screen over other apps or onto the lock screen.

The push sender authenticates the member who started the Ring and only notifies other members of that active Ring. Expired device subscriptions are removed automatically. The app shell is cached for offline loading; authentication, live Ring actions, and sending push notifications require a network connection.