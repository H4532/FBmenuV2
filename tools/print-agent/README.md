# FB Menus — kitchen print agent

Prints kitchen tickets on **Epson TM-U220B** (and other ESC/POS network printers)
when an order is **accepted** in the admin. Each station (Hot / Pastry / Cold…) gets
only its own dishes; notes and allergies print in **red** (two-colour ribbon).

## Why an agent?
Browsers can't open raw connections to network printers. This small program runs on
one always-on PC in the hotel network, asks the server for new tickets every 3 s
(outgoing HTTPS only — nothing is opened to the internet) and sends them to each
printer's IP on port 9100.

## Install (Windows, 5 minutes)
1. Install **Python 3** from python.org (tick "Add Python to PATH").
2. Create `C:\FBMenus\print-agent` and put `print_agent.py` and `run_agent.bat` in it.
3. Admin → **Printers → Add print agent** → copy the `config.json` shown (token is shown once).
   Save it in the same folder.
4. Double-click `run_agent.bat`. Admin → Printers shows **🟢 Print agent online**.
5. Auto-start: Task Scheduler → Create Basic Task → "When the computer starts" →
   Start a program → `C:\FBMenus\print-agent\run_agent.bat` → tick "Run whether user is logged on or not".

## Printers
- Find each printer's IP: switch it off, hold **FEED**, switch on → it prints a status sheet
  (or check your router/DHCP list). Give the printers **fixed IPs** so they don't change.
- Admin → Printers → **Add printer**: name, station, IP, port 9100, 40 characters/line (76 mm paper).
- **Test print** from the admin. Then assign each menu section to a printer.
- Mark one printer **Default** for sections without an assigned printer.

## Behaviour
- Printer off / out of paper: the ticket stays queued and is retried (up to 5 times);
  the admin shows the error on the printer card.
- Agent PC off: tickets wait up to 6 hours and print when it's back.
- **Reprint**: button on each accepted order card (prints "*** REPRINT ***" in red).
- Arabic: the TM-U220 cannot print Arabic script, so tickets use the English dish names.
- Log file: `print_agent.log` next to the script.
