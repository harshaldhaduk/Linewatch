#!/usr/bin/env python3
"""Dumps decrypted Underdog cookies from Edge to a JSON file."""
import sqlite3, os, shutil, subprocess, hashlib, json, sys
from Crypto.Cipher import AES

out_file = sys.argv[1] if len(sys.argv) > 1 else '/tmp/ud_cookies.json'
EDGE_BASE = os.path.expanduser("~/Library/Application Support/Microsoft Edge")

def get_key():
    r = subprocess.run(['security','find-generic-password','-w',
                        '-s','Microsoft Edge Safe Storage','-a','Microsoft Edge'],
                       capture_output=True, text=True)
    return hashlib.pbkdf2_hmac('sha1', r.stdout.strip().encode(), b'saltysalt', 1003, dklen=16)

def decrypt(enc, key):
    try:
        if enc[:3] == b'v10': enc = enc[3:]
        else: return None
        iv = b' ' * 16
        dec = AES.new(key, AES.MODE_CBC, iv).decrypt(enc)
        pad = dec[-1]
        if isinstance(pad, int) and 1 <= pad <= 16: dec = dec[:-pad]
        for skip in [32, 16, 0]:
            try:
                s = dec[skip:].decode('utf-8', errors='strict')
                if all(32 <= ord(c) <= 126 for c in s[:10]): return s
            except: pass
    except: pass
    return None

key = get_key()
db = os.path.join(EDGE_BASE, 'Default', 'Cookies')
tmp = '/tmp/ud_src.db'
shutil.copy2(db, tmp)
conn = sqlite3.connect(tmp)
rows = conn.execute(
    "SELECT host_key, name, value, encrypted_value, path, is_secure, is_httponly "
    "FROM cookies WHERE host_key LIKE '%underdogfantasy%' OR host_key LIKE '%underdogsports%'"
).fetchall()
conn.close()

out = []
for host, name, val, enc, cpath, secure, httponly in rows:
    if not val and enc:
        val = decrypt(bytes(enc), key) or ''
    if val:
        out.append({
            'domain': host, 'name': name, 'value': val,
            'path': cpath or '/', 'secure': bool(secure), 'httpOnly': bool(httponly)
        })

with open(out_file, 'w') as f:
    json.dump(out, f)
