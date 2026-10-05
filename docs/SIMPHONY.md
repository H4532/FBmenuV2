# Oracle Simphony integration (v2)

## What it does
- When staff press **Accept**, the order is created in Simphony as an **open check** in the configured revenue center. It uses each dish's **Simphony item no.**, the table number (or "ROOM 1204" in the check's information lines), the guest name and notes.
- The cashier **closes the check in Simphony** as usual: room charge to Opera, cash or card. Simphony prints the **tax invoice**, so ZATCA/Fatoora compliance stays entirely inside your certified POS.
- Each order is sent with Oracle's duplicate-request protection (`idempotencyId` = the order's id). Retrying can never create a second check.
- Order cards show **POS ✓ check 1234**, **POS sending…** or **POS failed**. A failed order has a **Send to Simphony again** button; hover over the tag to see the reason.
- **Training mode** (on by default) marks the checks as training checks, so they don't count in sales until go-live is approved.

## Creating the credentials (step by step)

**Before you start**
- Simphony Cloud with **STS Gen2 enabled by Oracle Hosting**.
- A Reporting & Analytics (R&A) user with the **Manage API Accounts** privilege.

### A. Create the API account (R&A)
1. Sign in to **Simphony Reporting and Analytics**.
2. Side menu → **Administration → System → API Accounts → Add API Account**.
3. Fill in:
   - **Type:** Simphony Transaction Services
   - **Account name:** e.g. `fbmenus-roshan` (cannot sign in to R&A itself)
   - **E-mail:** an IT mailbox you control (receives the password link and lock-out e-mails)
   - **Authorization scope:** *Selected* → Choose Locations → **only Holiday Inn Jeddah Corniche**
   - **Client scope:** **CLOUD**
   - **Redirect URL:** leave empty
4. **Add**, then **Copy** the **Client ID**.
5. Open the welcome e-mail and **set the password**.

### B. Collect the other values
| Field in Settings | Where to find it |
|---|---|
| Auth host | Usually your R&A address. To check, open `https://<host>/oidc-provider/v1/.well-known/openid-configuration`: it must show JSON. |
| API host | STS Gen2 address for your enterprise, from Oracle / IHG IT |
| Org short name | The organization typed on the R&A sign-in page |
| Location ref | EMC → the property's location reference |
| RVC ref | EMC → Roshan revenue center number |
| Employee no. | EMC → create a **"Web Orders"** employee in Roshan's RVC (role: begin check, add items, service total) → its object number |
| Order type(s) | EMC → Roshan RVC → Order Types (Dine-in; optionally Room Service) |
| Simphony item no. | EMC → Menu Item Maintenance → object number of each dish → Admin → Dishes |

### C. Connect
1. Admin → Settings → **Oracle Simphony**: enter everything, including the API username and password, then **Save**.
2. Press **Test connection**. It should show *OK — connected to …*.

### D. Keeping it running
- The API **password expires every 60 days**. The system renews its tokens **daily**, so orders keep flowing. After you reset the password (R&A sign-in page → *Can't sign in?*), enter the new one in Settings.
- Five wrong passwords lock the account for 30 minutes.
- Failures of the daily renewal appear under the Test result in Settings.

## Going live
1. Admin → Settings → **Oracle Simphony**: fill in all fields, save the API account, then press **Test connection**. It should show "OK — connected to …".
2. Leave **Training mode** on, switch **Send accepted orders to Simphony** on, and accept a test order. Check that it appears on a Simphony workstation.
3. When F&B and Finance approve, switch **Training mode** off.

## Notes
- **Sign-in:** the API account follows Oracle's documented flow (authorize → sign-in → token, with refresh tokens). The very first connection should be verified with IHG IT present, because tenant set-ups can differ.
- **Kitchen tickets:** you can keep them on the TM-U220B printers (Printers tab), or let Simphony's own kitchen printing/KDS take over. If Simphony prints to the kitchen, set the sections in the Printers tab to no printer to avoid double tickets.
- **Security:** the API password is stored in a private database table that no web page can read back. Only the server function uses it.
