#!/usr/bin/env python3
"""
PrizePicks Auto Cookie Extractor
Reads cookies from all Edge profiles — one profile per account.
Run with no args to update all accounts, or pass account index: python3 auto-cookie.py 0
"""

import sqlite3, os, shutil, subprocess, sys, json, glob
from Crypto.Cipher import AES
import hashlib, urllib.parse

APP_DIR    = os.path.dirname(os.path.abspath(__file__))
SAVED_FILE = os.path.join(APP_DIR, '.saved_cookies.json')
COOKIE_FILE= os.path.join(APP_DIR, '.cookie_update')
UD_AUTH_STATE_FILE = os.path.join(APP_DIR, '.ud_auth_state.json')
EDGE_BASE  = os.path.expanduser("~/Library/Application Support/Microsoft Edge")

def get_edge_key():
    r = subprocess.run(['security','find-generic-password','-w',
                        '-s','Microsoft Edge Safe Storage','-a','Microsoft Edge'],
                       capture_output=True, text=True)
    pw = r.stdout.strip().encode()
    return hashlib.pbkdf2_hmac('sha1', pw, b'saltysalt', 1003, dklen=16)

def decrypt(enc, key):
    try:
        # Strip v10 prefix (3 bytes)
        if enc[:3] == b'v10':
            enc = enc[3:]
        else:
            return None
        iv = b' ' * 16
        dec = AES.new(key, AES.MODE_CBC, iv).decrypt(enc)
        # Strip PKCS7 padding
        pad = dec[-1]
        if isinstance(pad, int) and 1 <= pad <= 16:
            dec = dec[:-pad]
        # The decrypted output has 32 bytes of garbage before the real value.
        # Skip full 16-byte AES blocks until we find a clean run of printable ASCII.
        # Check block boundaries: 0, 16, 32
        for skip in [32, 16, 0]:
            chunk = dec[skip:]
            # Check if this looks like clean ASCII (all chars printable)
            try:
                s = chunk.decode('utf-8', errors='strict')
                if all(32 <= ord(c) <= 126 for c in s[:20]):
                    return s
            except:
                pass
        # Fallback: find first run of 8+ consecutive printable ASCII bytes
        result = dec.decode('utf-8', errors='ignore')
        import re
        m = re.search(r'[ -~]{8,}', result)
        return m.group(0) if m else None
    except: return None

def cookies_from_profile(path, key):
    db = os.path.join(path, 'Cookies')
    if not os.path.exists(db): return None
    tmp = f"/tmp/pp_{os.path.basename(path)}.db"
    try: shutil.copy2(db, tmp)
    except: return None
    try:
        conn = sqlite3.connect(tmp)
        rows = conn.execute("SELECT name,value,encrypted_value FROM cookies WHERE host_key LIKE '%prizepicks%'").fetchall()
        conn.close()
    except: return None
    finally:
        try: os.unlink(tmp)
        except: pass

    c = {}
    for name, val, enc in rows:
        if val: c[name] = val
        elif enc:
            d = decrypt(bytes(enc), key)
            if d: c[name] = d

    if '_prizepicks_session' not in c and 'remember_user_token' not in c:
        return None

    pri = ['_prizepicks_session','remember_user_token','datadome',
           'cf_clearance','_px3','__cf_bm','CSRF-TOKEN','pp_uuid','_cfuvid','pxcts','_pxvid']
    out = {k:c[k] for k in pri if k in c}
    out.update({k:v for k,v in c.items() if k not in out})
    return '; '.join(f'{k}={v}' for k,v in out.items()), c

def get_username(c):
    try:
        trait = [p.split('=',1)[1] for p in '; '.join(f'{k}={v}' for k,v in c.items()).split('; ') if p.startswith('rl_trait=')]
        if trait:
            t = json.loads(urllib.parse.unquote(trait[0]))
            return t.get('username') or t.get('email','').split('@')[0] or '?'
    except: pass
    return '(logged in)'

def find_profiles():
    out = []
    for name in ['Default'] + [os.path.basename(p) for p in sorted(glob.glob(os.path.join(EDGE_BASE,'Profile *')))]:
        path = os.path.join(EDGE_BASE, name)
        if os.path.exists(path): out.append((name, path))
    return out

def main():
    target = int(sys.argv[1]) if len(sys.argv) > 1 else None
    print("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("  Linewatch Cookie Extractor")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")

    key = get_edge_key()
    found = []
    for name, path in find_profiles():
        result = cookies_from_profile(path, key)
        if result:
            cookie_str, raw = result
            user = get_username(raw)
            found.append((name, cookie_str, user))
            print(f"  ✓ Account {len(found)}: {user}")

    if not found:
        print("\n  ❌ No PrizePicks sessions found in Edge.")
        print("  Open Edge, go to prizepicks.com, and log in first.\n")
        sys.exit(1)

    print()

    saved = ['', '']
    if os.path.exists(SAVED_FILE):
        try:
            saved = json.loads(open(SAVED_FILE).read())
            if not isinstance(saved, list): saved = [saved, '']
            while len(saved) < max(2, len(found)): saved.append('')
        except: pass

    if target is not None:
        if target >= len(found):
            print(f"  ❌ Only {len(found)} profile(s) found.")
            sys.exit(1)
        _, cookie_str, user = found[target]
        saved[target] = cookie_str
        with open(SAVED_FILE,'w') as f: json.dump(saved, f)
        with open(COOKIE_FILE,'w') as f: json.dump({"account":target,"cookie":cookie_str}, f)
        print(f"  ✅ PrizePicks cookies synced (account {target}: {user})\n")
    else:
        # Update all
        for i,(_, cookie_str, user) in enumerate(found):
            if i < len(saved): saved[i] = cookie_str
            else: saved.append(cookie_str)
        with open(SAVED_FILE,'w') as f: json.dump(saved, f)
        with open(COOKIE_FILE,'w') as f: json.dump({"account":0,"cookie":saved[0]}, f)
        print(f"  ✅ PrizePicks cookies synced ({len(found)} account(s))")

    ud_token, ud_err, ud_profile = extract_underdog(key)
    if ud_token:
        with open(UD_TOKEN_FILE, 'w') as f:
            json.dump({"token": ud_token}, f)
        write_ud_auth_state(True, f"token synced from {ud_profile}")
        print(f"  ✅ Underdog token synced ({ud_profile})")
    else:
        if ud_err and ud_err.startswith("Found Underdog refresh cookie"):
            write_ud_auth_state(True, "refresh cookie found; browser token capture required")
            print("  ✅ Underdog cookies synced (1 account(s))")
        elif ud_err and ud_err.startswith("Only leftover Underdog"):
            write_ud_auth_state(False, ud_err)
            print(f"  ❌ Underdog logged out: {ud_err}")
        else:
            write_ud_auth_state(False, ud_err)
            print(f"  ❌ Underdog cookies not synced: {ud_err}")

    onyx_token_file = os.path.join(APP_DIR, '.onyx_token.json')
    try:
        onyx_data = json.loads(open(onyx_token_file).read())
        if onyx_data.get('sessionValid'):
            print("  ✅ Onyx cookies synced (1 account(s))")
        else:
            print("  ⚠️  Onyx session invalid – open Linewatch to log in")
    except:
        print("  ⚠️  Onyx session not found – open Linewatch to log in")
    print()

# ── Underdog Fantasy token extraction ────────────────────────────────────────
import urllib.request, ssl

UD_TOKEN_FILE = os.path.join(APP_DIR, '.ud_token.json')

def write_ud_auth_state(logged_in, reason):
    try:
        with open(UD_AUTH_STATE_FILE, 'w') as f:
            json.dump({"loggedIn": bool(logged_in), "reason": reason or "", "ts": __import__('time').time()}, f)
    except:
        pass

def ud_cookies_from_profile(path, key):
    """Extract Underdog session cookies from Edge profile."""
    db = os.path.join(path, 'Cookies')
    if not os.path.exists(db): return None
    tmp = f"/tmp/ud_{os.path.basename(path)}.db"
    try: shutil.copy2(db, tmp)
    except: return None
    try:
        conn = sqlite3.connect(tmp)
        rows = conn.execute("SELECT name,value,encrypted_value FROM cookies WHERE host_key LIKE '%underdogfantasy%' OR host_key LIKE '%underdogsports%'").fetchall()
        conn.close()
    except: return None
    finally:
        try: os.unlink(tmp)
        except: pass

    c = {}
    for name, val, enc in rows:
        if val: c[name] = val
        elif enc:
            d = decrypt(bytes(enc), key)
            if d: c[name] = d

    if 'session_refresh' in c:
        return c, 'refresh'
    if any('dcdd' in k for k in c):
        return c, 'leftover'
    return None, None

def ud_refresh_token(cookies):
    """Use session_refresh cookie to get a fresh Bearer token."""
    refresh = cookies.get('session_refresh', '')
    if not refresh:
        return None

    # Send the full Underdog cookie jar. The refresh endpoint has changed which
    # browser/session cookies it expects a few times.
    cookie_str = '; '.join(f'{k}={v}' for k,v in cookies.items() if v)

    try:
        ctx = ssl._create_unverified_context()
        req = urllib.request.Request(
            'https://api.underdogfantasy.com/v1/user/token',
            method='GET',
            headers={
                'accept': 'application/json',
                'cookie': cookie_str,
                'origin': 'https://app.underdogfantasy.com',
                'referer': 'https://app.underdogfantasy.com/',
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'client-type': 'web',
            }
        )
        resp = urllib.request.urlopen(req, timeout=10, context=ctx)
        data = json.loads(resp.read())
        token = data.get('data', {}).get('token') or data.get('token')
        if token:
            return token
    except Exception as e:
        pass

    # Fallback: try the auth0 refresh endpoint
    try:
        ctx = ssl._create_unverified_context()
        # Get the device id
        device_id = cookies.get('ud-device-id', 'unknown')
        post_data = json.dumps({
            'grant_type': 'refresh_token',
            'refresh_token': refresh,
            'client_id': 'cQvYz1T2BAFbix4dYR37dyD9O0Thf1s6',
            'audience': 'https://api.underdogfantasy.com',
            'scope': 'offline_access',
        }).encode()
        req = urllib.request.Request(
            'https://login.underdogsports.com/oauth/token',
            data=post_data,
            method='POST',
            headers={
                'content-type': 'application/json',
                'origin': 'https://app.underdogfantasy.com',
                'user-agent': 'Mozilla/5.0',
            }
        )
        resp = urllib.request.urlopen(req, timeout=10, context=ctx)
        data = json.loads(resp.read())
        return data.get('access_token')
    except Exception as e:
        pass

    return None

def extract_underdog(key):
    """Extract an Underdog token from the first Edge profile with a valid session."""
    saw_refresh_cookie = False
    saw_leftover_cookie = False
    for name, path in find_profiles():
        cookies, state = ud_cookies_from_profile(path, key)
        if not cookies:
            continue
        if state == 'leftover':
            saw_leftover_cookie = True
            continue
        saw_refresh_cookie = True
        token = ud_refresh_token(cookies)
        if token:
            return token, None, name

    if saw_refresh_cookie:
        return None, "Found Underdog refresh cookie but failed to refresh token", None
    if saw_leftover_cookie:
        return None, "Only leftover Underdog browser cookies found; no active login refresh cookie", None
    return None, "No Underdog session found in any Edge profile", None

if __name__ == '__main__':
    main()
