# Oracle Simphony integration (v2)

## What it does
- When staff press **Accept**, the order is created in Simphony as an **open check** in the configured revenue center. It uses each dish's **Simphony item no.**, the table number (or "ROOM 1204" in the check's information lines), the guest name and notes.
- The cashier **closes the check in Simphony** as usual: room charge to Opera, cash or card. Simphony prints the **tax invoice**, so ZATCA/Fatoora compliance stays entirely inside your certified POS.
- Each order is sent with Oracle's duplicate-request protection (`idempotencyId` = the order's id). Retrying can never create a second check.
- Order cards show **POS ✓ check 1234**, **POS sending…** or **POS failed**. A failed order has a **Send to Simphony again** button; hover over the tag to see the reason.
- **Training mode** (on by default) marks the checks as training checks, so they don't count in sales until go-live is approved.

## Checklist for IHG IT / Oracle
1. **Simphony Cloud with Transaction Services Gen2 (STS Gen2).** STS Gen2 is only available for Simphony Standard Cloud Service hosted by Oracle, and Oracle Hosting must enable it for the enterprise or property. On-premises Simphony 2.x/18.x uses the older SOAP Transaction Services; that would need a different connector, so tell us which you have.
2. **An API account** (Simphony Reporting & Analytics → API accounts) for STS Gen2, providing:
   - the **API host** (STS) and **Auth host** (identity service) URLs;
   - the **Client ID**;
   - the account **username / password**.
3. From Simphony EMC:
   - the **Org short name**;
   - the **Location ref** of Holiday Inn Jeddah Corniche;
   - the **Revenue center (RVC) number** for Roshan;
   - a dedicated **employee** object number for web orders (e.g. "Web Orders");
   - the **order type** number (and optionally a separate one for room service).
4. The **menu item object number** of every dish. Enter them in Admin → Dishes → edit dish → "Simphony item no.". Choices such as Chicken or Beef are sent as reference text; if Simphony should receive them as condiments, send us the condiment numbers.

## Going live
1. Admin → Settings → **Oracle Simphony**: fill in all fields, save the API account, then press **Test connection**. It should show "OK — connected to …".
2. Leave **Training mode** on, switch **Send accepted orders to Simphony** on, and accept a test order. Check that it appears on a Simphony workstation.
3. When F&B and Finance approve, switch **Training mode** off.

## Notes
- **Sign-in:** the API account follows Oracle's documented flow (authorize → sign-in → token, with refresh tokens). The very first connection should be verified with IHG IT present, because tenant set-ups can differ.
- **Kitchen tickets:** you can keep them on the TM-U220B printers (Printers tab), or let Simphony's own kitchen printing/KDS take over. If Simphony prints to the kitchen, set the sections in the Printers tab to no printer to avoid double tickets.
- **Security:** the API password is stored in a private database table that no web page can read back. Only the server function uses it.
