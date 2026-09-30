# Guest accounts

Guests tap the **person icon** at the top of the menu to create an account or sign in.

## What a signed-in guest gets
- **Favourites:** tap ♡ on a dish. Favourites show with ♥ in the menu and in the account, with a one-tap “+ Add”.
- **My orders:** order history across all outlets. Orders placed while signed in are linked automatically.
- **Loyalty points:** earned when a linked order is marked **Served**. The rate is set in Admin → Settings → Guest ordering (default 1 point per SAR). Paying with points is prepared for a later version.
- **Preferences:** diet and allergies. They are saved to the account and applied to the menu filters automatically on every device.

## Sign-in methods
- **E-mail + password:** works now. Accounts are created by the `guest-register` function, already confirmed, with no e-mail step. Limited to 5 sign-ups per hour per network.
- **Google / Apple / Facebook:** the buttons appear **automatically** as soon as a provider is switched on in Supabase. No code change is needed.

### Switching on Google (≈15 min, free)
1. <https://console.cloud.google.com> → create a project → **APIs & Services → OAuth consent screen**: External, app name “Roshan Restaurant”, your e-mail.
2. **Credentials → Create credentials → OAuth client ID** → Web application.
   - Authorized redirect URI: `https://swjffroqtxfbsmtjpimw.supabase.co/auth/v1/callback`
3. Copy the **Client ID** and **Client secret**.
4. Supabase → Authentication → **Sign In / Providers → Google** → enable, then paste both.
5. Supabase → Authentication → **URL Configuration** → add `https://h4532.github.io/fb-menus/**` to Redirect URLs.

### Switching on Apple (needs an Apple Developer account, $99/year)
1. developer.apple.com → Identifiers → create an **App ID** and a **Services ID**. Enable “Sign in with Apple” and set the return URL to the Supabase callback above.
2. Create a **Key** with Sign in with Apple and download the .p8 file.
3. Supabase → Providers → **Apple**: enter the Services ID, Team ID, Key ID and the .p8 key (Supabase generates the secret).

### Switching on Facebook (optional)
1. developers.facebook.com → create an app → add **Facebook Login** with the valid OAuth redirect set to the Supabase callback above.
2. Supabase → Providers → **Facebook**: enter the App ID and App Secret. Meta requires a privacy-policy URL and app review before the public can use it.

## Privacy
- Guests only see their own profile, favourites, points and orders. Row-level security was tested with a guest session: all staff data returns nothing.
- Staff and guests share the login system, but guests have no rights in the admin.
- Guest sessions on the menu are stored separately from staff sessions in the admin.
