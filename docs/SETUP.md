# FB Menus — setup guide

This guide covers the full setup from zero. For the Holiday Inn Jeddah Corniche
installation, **steps 1–2 are already done** (Supabase project `fb-menus`,
ref `swjffroqtxfbsmtjpimw`, region Frankfurt). Start at step 3.

---

## 1. Create the Supabase project *(done)*

1. Go to <https://supabase.com/dashboard> and choose **New project**.
2. Name it `fb-menus`. Pick the region closest to your guests (Frankfurt `eu-central-1` works well for Jeddah).
3. Save the database password in your password manager. You won't need it day to day.

**Plan:** free projects can be paused after about a week of low activity.
Before QR codes go on tables, upgrade the project to **Pro**. Pro also adds daily backups.

## 2. Run the SQL *(done)*

In **SQL Editor → New query**, paste and run each file from the `supabase/` folder, **in this order**:

| # | File | What it does |
|---|------|--------------|
| 1 | `01_schema.sql` | Tables, constraints |
| 2 | `02_functions.sql` | Triggers, `get_public_menu`, reorder functions |
| 3 | `03_rls.sql` | Row-level security (who can read/write what) |
| 4 | `04_storage.sql` | `menu-photos` bucket and upload rules |
| 5 | `05_private_helpers.sql` | Moves access helpers out of the public API |
| 6 | `06_composite_fk_indexes.sql` | Performance indexes |
| 7 | `seed/roshan.sql` | Roshan outlet and its menu |

Then go to **Advisors → Security Advisor**. It should report no issues.

## 3. Lock down sign-in

In **Authentication → Sign In / Providers**:

- Turn **off** “Allow new users to sign up”. Only people you add can sign in.
- Keep **Email** enabled.

In **Authentication → URL Configuration** (after step 5, once you know the site address):

- **Site URL:** `https://<github-user>.github.io/FBMENUV2/admin/`
- **Redirect URLs:** add the same address. Password-reset links only work for addresses listed here.

## 4. Create the manager's login

1. **Authentication → Users → Add user → Create new user.**
2. Enter the manager's email and a temporary password. Tick **Auto confirm user**.
3. Link the account to Roshan in the **SQL Editor** (replace the email):

```sql
insert into public.outlet_admins (outlet_id, user_id, role)
select o.id, u.id, 'owner'            -- 'owner' = content + settings, 'editor' = content only
from public.outlets o, auth.users u
where o.slug = 'roshan'
  and u.email = 'manager@example.com'
on conflict (outlet_id, user_id) do update set role = excluded.role;
```

The manager can change the password after signing in (account icon → Change password).
To give someone access to several outlets, run the insert once per outlet slug.

To remove someone's access:

```sql
delete from public.outlet_admins
where user_id = (select id from auth.users where email = 'person@example.com');
```

### Devices and activity log

Also under **Admin → Users**:

- **Devices:** every phone/computer registered for order notifications — who it belongs to, when it was registered, and when it was last successfully notified. **Remove** here (or the person doing it themselves from the Orders tab) stops that device from getting notifications.
- **Activity log:** sign-ins, users added/changed/removed, passwords reset, and devices registered/removed for this restaurant, newest first, with who did it and when.
- Both require the **Users** right to view.

### Managing staff after setup

Once you are signed in as an owner, use **Admin → Users** instead of SQL:

- **+ Add user:** enter an e-mail, an optional name and a temporary password, then choose a role or tick individual rights. Share the sign-in details shown afterwards; the user changes the password after signing in.
- **Roles:** Owner (everything), Manager (all but Users), Menu editor (Dishes + Menus), Order staff (Orders), or Custom.
- **Rights:**
  - Orders
  - Dishes: prices, sold out, photos, allergens, prep time
  - Menus & choices
  - Settings
  - Users
- Rights are enforced by the database, not just hidden in the screens.
- Only owners can create owners or give the Users right. You can't remove yourself or the last owner.
- **Remove** takes away access; the login is deleted if the person has no other restaurant.

## 5. Publish on GitHub Pages

1. On GitHub, create a **public** repository named `FBMENUV2`. GitHub Pages is free for public repos.
   The only key in the code is the Supabase *publishable* key, which is designed to be public.
2. Put the contents of this folder at the root of the repository, so `index.html`, `roshan/`, `admin/` and `assets/` sit at the top level. Use one of these:
   - **Browser:** open the repo, choose **Add file → Upload files**, and drag in all files and folders.
   - **Git:**
     ```bash
     git init && git add . && git commit -m "FB Menus"
     git branch -M main
     git remote add origin https://github.com/<github-user>/FBMENUV2.git
     git push -u origin main
     ```
3. **Settings → Pages → Build and deployment:** set Source to “Deploy from a branch”, Branch to `main`, and folder to `/ (root)`. Save.
4. After about a minute the site is live:
   - Guest menu: `https://<github-user>.github.io/FBMENUV2/roshan/`
   - Admin: `https://<github-user>.github.io/FBMENUV2/admin/`
   - QR tool: `https://<github-user>.github.io/FBMENUV2/tools/qr.html`
5. Go back to step 3 and set the Site URL and Redirect URLs.

**Custom domain (optional):** for a domain such as `menu.hijeddah.com`, add it in **Settings → Pages → Custom domain** and create the DNS record GitHub shows you.
Shorter addresses make simpler QR codes that scan more easily.

## 6. Print the QR codes

Open `tools/qr.html` on the live site.

- **Tables:**
  1. Choose type **Tables**.
  2. Enter the table numbers, e.g. `1-24`.
  3. Each card links to `…/roshan/?t=12`.
- **Rooms:**
  1. Choose type **Guest rooms**.
  2. Enter room ranges, e.g. `101-130, 201-230`.
  3. Links look like `…/roshan/?r=1204`. When a room-service extension is set in the admin (**Settings → Contact**), guests who scan a room code see “Order from your room: dial …”.
- **One general code:** for the door, the lobby or tent cards.
- To open a specific menu (e.g. an in-room dining menu), enter its slug in **Open a specific menu**.

Before printing, open the **Test link** on a phone. Print on A4 with 9 cards per page, then laminate.
A QR code never needs reprinting when prices or dishes change, because the manager updates the menu live.

## 7. Everyday use (manager)

| Task | Where |
|------|-------|
| Change a price | **Dishes**: tap the price, type, press Enter |
| Sold out today | **Dishes**: flip the switch (guests see “Sold out today”) |
| Reorder dishes | **Dishes**: drag the ⋮⋮ handle |
| Add/edit a dish, photo, allergens | **Dishes**: tap the dish name |
| Serving hours, buffet prices | **Menus → Edit menu** |
| Sections | **Menus → + Add section** / tap a section |
| Sizes, sides, add-ons | **Choices**, then tick the group on each dish |
| Service charge, notes, contact, hours | **Settings** (owner only) |

Guests get changes the next time they open or refresh the menu.

## 8. Updating the code

After you change any CSS or JS file (optional since pages and code are fetched network-first; it forces old offline copies to be dropped):

1. Open `sw.js` and change the `BUILD` value, e.g. `'2026-10-02-1'`.
2. Commit and push.

Guests' phones then download the new files instead of serving their saved copy.

## 9. Before launch checklist

- [ ] Chef has verified the **allergens** on every dish. The seed values are provisional; dishes with none set show an orange “No allergens set” tag in the admin.
- [ ] Steak Sandwich: Arabic and English names now describe the same dish.
- [ ] “Midnight Meals”: serving hours set if it's a late-night section.
- [ ] Drinks and snacks menu added.
- [ ] Sign-ups disabled; Site URL and Redirect URLs set.
- [ ] Project upgraded to Supabase Pro.
- [ ] QR test links scanned on an iPhone and an Android phone, on hotel Wi-Fi.
