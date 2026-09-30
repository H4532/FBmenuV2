# FB Menus — v2

> Live: https://h4532.github.io/FBmenuV2/ · Version 1 (unchanged) stays at https://github.com/H4532/fb-menus

Online menus for hotel restaurants and cafés: guests scan a QR code, managers update dishes, prices and availability live.
One codebase serves every outlet.

- **Guest menu:** static pages on GitHub Pages. Arabic and English (French ready). Loads the whole menu in one request of about 9 KB, keeps a copy for weak Wi-Fi, works offline.
- **Admin:** `/admin/`, for phone or tablet. Dishes, prices, sold-out switch, drag-to-reorder, photos, allergens, choices, serving hours and buffet prices.
- **Backend:** Supabase (Postgres + Auth + Storage). Row-level security gives guests read-only access and lets admins edit only their own outlet.

| Path | What |
|------|------|
| `roshan/` | Roshan Restaurant guest page + `config.js` (branding) |
| `admin/` | Admin panel |
| `tools/qr.html` | Printable QR cards for tables and rooms |
| `assets/` | Shared CSS, JS, fonts, vendor libraries (self-hosted, no CDN) |
| `supabase/` | Database SQL (run in order) and seed files |
| `docs/SETUP.md` | Setup, deployment, QR codes, launch checklist |
| `docs/NEW-OUTLET.md` | Adding an outlet (Moood example) |
| `sw.js` | Service worker. Bump `BUILD` after changing CSS/JS |

## Credits

- Readex Pro (SIL OFL) by Thomas Jockin & Nadine Chahine
- Saudi Riyal symbol font (SIL OFL) by Emran Alhaddad
- supabase-js (MIT), SortableJS (MIT), qrcode-generator (MIT)
