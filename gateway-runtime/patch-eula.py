#!/usr/bin/env python3
"""
Patch the Suprema device_gateway_linux_x64 binary (V1.8.0) to accept
LICENSE.txt as EULA.txt. The binary stores an MD5 hex hash of the expected
EULA file; this script replaces it with the MD5 of the bundled LICENSE.txt.

Usage:
  1. Place device_gateway_linux_x64 and LICENSE.txt in this directory
  2. python3 gateway-runtime/patch-eula.py
  3. The patched binary is written in-place and EULA.txt is created
"""
import hashlib, shutil, sys, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BINARY     = os.path.join(SCRIPT_DIR, "device_gateway_linux_x64")
LICENSE    = os.path.join(SCRIPT_DIR, "LICENSE.txt")
EULA       = os.path.join(SCRIPT_DIR, "EULA.txt")

# Known embedded MD5 for V1.8.0 (47fc3556b6798b4eb66e7d7ddb6c2e4b)
KNOWN_HASH = b"47fc3556b6798b4eb66e7d7ddb6c2e4b"

def die(msg):
    print(f"[patch-eula] ERROR: {msg}")
    sys.exit(1)

if not os.path.isfile(BINARY):
    die(f"Binary not found: {BINARY}\n  Extract device_gateway_linux_x64 from the .7z archive first.")

if not os.path.isfile(LICENSE):
    die(f"LICENSE.txt not found: {LICENSE}\n  It ships inside the same .zip as the binary.")

# Read + convert LICENSE.txt to LF line endings -> EULA.txt
with open(LICENSE, "rb") as f:
    content = f.read().replace(b"\r\n", b"\n").replace(b"\r", b"\n")

our_md5 = hashlib.md5(content).hexdigest().encode("ascii")
print(f"[patch-eula] LICENSE.txt MD5 (LF): {our_md5.decode()}")

with open(EULA, "wb") as f:
    f.write(content)
print(f"[patch-eula] Written: {EULA}")

# Read binary and find the embedded hash
with open(BINARY, "rb") as f:
    data = bytearray(f.read())

idx = data.find(KNOWN_HASH)
if idx == -1:
    # Maybe already patched with a different hash — try our own
    idx = data.find(our_md5)
    if idx != -1:
        print("[patch-eula] Binary already patched with correct hash. Nothing to do.")
        sys.exit(0)
    die(f"Could not find expected hash in binary.\n"
        f"  This script only supports V1.8.0. Check the binary version with: ./device_gateway_linux_x64 -v")

print(f"[patch-eula] Found embedded hash at offset: {hex(idx)}")
data[idx:idx+32] = our_md5
backup = BINARY + ".orig"
shutil.copy2(BINARY, backup)
print(f"[patch-eula] Backup saved: {backup}")

with open(BINARY, "wb") as f:
    f.write(data)
os.chmod(BINARY, 0o755)
print(f"[patch-eula] Patched: {BINARY}")
print("[patch-eula] Done. You can now run: systemctl restart device-gateway")
