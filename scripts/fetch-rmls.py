#!/usr/bin/env python3
"""Fetch an RMLS page and dump the raw HTML to a file for inspection.

Usage:
    python fetch-rmls.py <url>
"""

import os
import sys
import urllib.request

if len(sys.argv) < 2:
    print("Usage: python fetch-rmls.py <url>")
    sys.exit(1)

url = sys.argv[1]
print(f"Fetching {url}...")
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, timeout=30) as resp:
    html = resp.read().decode("utf-8", errors="replace")

out = os.path.join(os.environ.get("TEMP", "/tmp"), "rmls-dump.html")
with open(out, "w", encoding="utf-8") as f:
    f.write(html)

print(f"Wrote {len(html):,} bytes to {out}")
