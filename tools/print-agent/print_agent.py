#!/usr/bin/env python3
"""
FB Menus — kitchen print agent  (Epson TM-U220B and other ESC/POS printers)

Runs on any always-on PC on the hotel network. Every few seconds it asks the
server for new kitchen tickets (created when staff press "Accept"), sends each
one to the right printer by IP (raw TCP, port 9100) and reports the result.

Python 3.8+ only — no extra packages.  Setup: see README.md in this folder.
    python print_agent.py            (reads config.json next to this file)
    python print_agent.py --once     (one poll, then exit — for testing)
"""
import json, socket, sys, time, urllib.request, urllib.error, unicodedata, logging, os
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, 'config.json'), encoding='utf-8'))
URL, KEY, TOKEN = CFG['supabase_url'].rstrip('/'), CFG['publishable_key'], CFG['agent_token']
POLL = float(CFG.get('poll_seconds', 3))

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s',
                    handlers=[logging.StreamHandler(), logging.FileHandler(os.path.join(HERE, 'print_agent.log'), encoding='utf-8')])
log = logging.getLogger('agent')

# ------------------------------------------------------------------ server API
def rpc(fn, body, timeout=15):
    req = urllib.request.Request(f'{URL}/rest/v1/rpc/{fn}', data=json.dumps(body).encode(),
                                 headers={'apikey': KEY, 'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw) if raw else None

# ------------------------------------------------------------------ ESC/POS
ESC, GS = b'\x1b', b'\x1d'
INIT      = ESC + b'@'
LEFT, CENTER = ESC + b'a\x00', ESC + b'a\x01'
NORMAL, DOUBLE_H, DOUBLE_HW = ESC + b'!\x00', ESC + b'!\x10', ESC + b'!\x30'
BLACK, RED = ESC + b'r\x00', ESC + b'r\x01'          # TM-U220: two-colour ribbon
FEED = lambda n: ESC + b'd' + bytes([n])
CUT = GS + b'V\x42\x03'                               # feed + partial cut (TM-U220B autocutter)

def ascii_text(s):
    """The TM-U220 has no Arabic shaping: print Latin text, strip everything else."""
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode()
    return ' '.join(s.split())

def en(obj):
    if isinstance(obj, dict):
        return obj.get('en') or next((v for v in obj.values() if ascii_text(v)), '') or ''
    return str(obj or '')

def wrap(text, width, indent=''):
    words, lines, cur = ascii_text(text).split(' '), [], ''
    for w in words:
        if len(cur) + len(w) + (1 if cur else 0) > width - len(indent):
            if cur: lines.append(indent + cur)
            cur = w
        else:
            cur = f'{cur} {w}' if cur else w
    if cur: lines.append(indent + cur)
    return lines or [indent]

def line(text=''):
    """Keep leading indentation; drop characters the printer can't print."""
    s = unicodedata.normalize('NFKD', str(text or '')).encode('ascii', 'ignore')
    return s.rstrip() + b'\n'

def local_time(iso, tzname):
    if not iso: return ''
    dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
    offsets = {'Asia/Riyadh': 3, 'Asia/Dubai': 4, 'Africa/Algiers': 1, 'UTC': 0}   # no DST in these zones
    return (dt.astimezone(timezone(timedelta(hours=offsets.get(tzname, 3))))).strftime('%H:%M')

def ticket(job, outlet):
    p, pay, w = job['printer'], job['payload'], int(job['printer'].get('width') or 40)
    red = RED if p.get('red', True) else BLACK
    tz = outlet.get('timezone') or 'Asia/Riyadh'
    out = bytearray(INIT)
    if job['kind'] == 'test':
        out += CENTER + DOUBLE_HW + line('TEST PRINT') + NORMAL
        out += line(f"{p['name']} - {p['station']}") + line(f"{p['host']}:{p['port']}")
        out += line(datetime.now().strftime('%Y-%m-%d %H:%M:%S')) + red + line('Red ribbon OK') + BLACK
        out += line('Printer is connected to FB Menus') + FEED(4) + CUT
        return bytes(out)

    where = f"{'ROOM' if pay.get('location_type') == 'room' else 'TABLE'} {pay.get('location', '')}"
    out += CENTER + NORMAL + line(en(outlet.get('name')).upper())
    out += DOUBLE_HW + line(f"** {str(p.get('station', '')).upper()} **") + NORMAL
    if job['kind'] == 'reprint':
        out += red + DOUBLE_H + line('*** REPRINT ***') + NORMAL + BLACK
    out += LEFT + DOUBLE_HW + line(f"#{pay.get('order_no')}  {where}") + NORMAL
    t = f"Ordered {local_time(pay.get('created_at'), tz)}"
    if pay.get('ready_by'): t += f"   Ready by {local_time(pay.get('ready_by'), tz)}"
    elif pay.get('estimated_minutes'): t += f"   ~{pay['estimated_minutes']} min"
    out += line(t) + line('-' * w)
    for l in pay.get('lines', []):
        first = True
        for s in wrap(f"{l.get('qty')} x {en(l.get('name'))}", w):
            out += (DOUBLE_H if first else b'') + line(s) + NORMAL
            first = False
        for o in l.get('options') or []:
            for s in wrap(f"- {en(o.get('group'))}: {en(o.get('option'))}", w, '   '):
                out += line(s)
        if l.get('note'):
            out += red
            for s in wrap(f"! {l['note']}", w, '   '): out += line(s)
            out += BLACK
    out += line('-' * w)
    if pay.get('guest_note'):
        out += red + DOUBLE_H
        for s in wrap(f"NOTE: {pay['guest_note']}", w): out += line(s)
        out += NORMAL + BLACK
    if pay.get('guest_name'): out += line(f"Guest: {pay['guest_name']}")
    out += FEED(4) + CUT
    return bytes(out)

def send(host, port, data, copies=1):
    with socket.create_connection((host, int(port)), timeout=8) as s:
        for _ in range(max(1, int(copies))):
            s.sendall(data)

# ------------------------------------------------------------------ main loop
def poll_once():
    res = rpc('agent_claim_jobs', {'p_token': TOKEN}) or {}
    outlet, jobs = res.get('outlet') or {}, res.get('jobs') or []
    for job in jobs:
        p = job['printer']
        try:
            send(p['host'], p['port'], ticket(job, outlet), p.get('copies', 1))
            rpc('agent_report', {'p_token': TOKEN, 'p_job': job['id'], 'p_ok': True})
            log.info("printed %s ticket %s on %s (%s)", job['kind'], (job['payload'] or {}).get('order_no', ''), p['name'], p['host'])
        except Exception as e:                                    # printer off, paper out, wrong IP…
            rpc('agent_report', {'p_token': TOKEN, 'p_job': job['id'], 'p_ok': False, 'p_error': f'{type(e).__name__}: {e}'})
            log.warning("FAILED on %s (%s): %s — will retry", p['name'], p['host'], e)
    return len(jobs)

def main():
    log.info('FB Menus print agent started — polling every %ss', POLL)
    once = '--once' in sys.argv
    backoff = POLL
    while True:
        try:
            poll_once()
            backoff = POLL
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors='ignore')
            if 'AGENT_UNKNOWN' in body:
                log.error('This agent token is not valid (removed in the admin?). Create a new agent in Admin → Printers.')
                sys.exit(2)
            log.warning('Server error %s: %s', e.code, body[:200]); backoff = min(60, backoff * 2)
        except Exception as e:                                    # no internet, DNS…
            log.warning('Cannot reach server: %s', e); backoff = min(60, backoff * 2)
        if once: break
        time.sleep(backoff)

if __name__ == '__main__':
    main()
