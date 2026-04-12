#!/usr/bin/env python3
"""Import RMLS listings from a complete list URL or local HTML file into house-hunt blob storage.

Usage:
    # Fetch from URL and import
    python import-rmls.py https://www.rmlsweb.com/v2/public/report.asp?...

    # Import from local HTML (recommended - fetch first with fetch-rmls.py)
    python import-rmls.py /tmp/rmls-dump.html

    # Dry run - parse and preview without uploading
    python import-rmls.py --dry-run /tmp/rmls-dump.html

Requires: az cli logged in with blob access to househuntdata storage account.
"""

import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from datetime import datetime, timezone


STORAGE_ACCOUNT = "househuntdata"
CONTAINER = "properties"
BLOB_NAME = "properties.json"

NETWORK_TIMEOUT = 15  # seconds for all network calls

# Windows needs shell=True for subprocess to find .cmd executables like az.cmd
_SHELL = platform.system() == "Windows"


def progress(step, total, msg):
    """Print a progress line with step counter."""
    pct = int(step / total * 100) if total else 0
    print(f"  [{step}/{total}] ({pct}%) {msg}")


def download_blob():
    """Download properties.json from Azure Blob Storage."""
    tmp = os.path.join(tempfile.gettempdir(), "properties_import.json")
    subprocess.run(
        ["az", "storage", "blob", "download",
         "--account-name", STORAGE_ACCOUNT,
         "--container-name", CONTAINER,
         "--name", BLOB_NAME,
         "--file", tmp,
         "--overwrite",
         "--auth-mode", "login"],
        capture_output=True, check=True, timeout=30, shell=_SHELL
    )
    with open(tmp) as f:
        return json.load(f)


def upload_blob(data):
    """Upload properties.json back to Azure Blob Storage."""
    tmp = os.path.join(tempfile.gettempdir(), "properties_import.json")
    with open(tmp, "w") as f:
        json.dump(data, f)
    subprocess.run(
        ["az", "storage", "blob", "upload",
         "--account-name", STORAGE_ACCOUNT,
         "--container-name", CONTAINER,
         "--name", BLOB_NAME,
         "--file", tmp,
         "--overwrite",
         "--auth-mode", "login"],
        capture_output=True, check=True, timeout=30, shell=_SHELL
    )


def fetch_rmls_page(url):
    """Fetch the RMLS page HTML."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=NETWORK_TIMEOUT) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_listings(html):
    """Parse listings from RMLS complete list HTML.

    Extracts from the actual RMLS "Client Full" report format:
    - MLS#: from <b>MLS#: 279816536</b>
    - Address + lat/lon: from MGS_ShowMap_Ex('...&lat=X&lon=Y&address=STREET, City, ZIP',...)
    - Price: from <span id="PRICE"...>$624,900</span>
    - Bed/bath/sqft: from <span id="BED_BATH"...>4 bd | 2 / 0 ba | 1768 sqft</span>
    - Photo dir: from photourls['photoNNN']="dir/path/";
    """
    listings = []

    # MLS# anchors — each starts a listing section
    mls_pattern = re.compile(r"<b>MLS#:\s*(\d+)</b>")
    mls_matches = list(mls_pattern.finditer(html))

    if not mls_matches:
        print("  No MLS numbers found in expected format!")
        return listings

    # Address + coordinates from the map link JavaScript
    map_pattern = re.compile(
        r"lat=([\d.]+)&amp;lon=(-?[\d.]+)&amp;address=([^'\"&]+)"
    )

    # Price from the PRICE span
    price_pattern = re.compile(r'id="PRICE"[^>]*>\$\s*([\d,]+)')

    # Bed/bath/sqft from the BED_BATH span: "4 bd | 2 / 0 ba | 1768 sqft"
    bed_bath_pattern = re.compile(
        r'id="BED_BATH"[^>]*>(\d+)\s*bd\s*\|\s*(\d+)\s*/\s*(\d+)\s*ba\s*\|\s*([\d,]+)\s*sqft'
    )

    # Photo URL directory from JavaScript: photourls['photoNNN']="dir/";
    photo_dir_pattern = re.compile(r"photourls\['photo\d+'\]=\"([^\"]+)\"")

    # Per-listing RMLS report link from PhotoViewer onclick:
    #   linkPhotoViewerMLN_NNN' onclick="PhotoViewer('?CRPT2=TOKEN..."
    listing_link_pattern = re.compile(
        r"linkPhotoViewerMLN_(\d+)'[^>]*onclick=\"PhotoViewer\('\?CRPT2=([A-Za-z0-9+/=]+)"
    )

    for i, mls_match in enumerate(mls_matches):
        mls_id = mls_match.group(1)

        # Section: from this MLS to the next (or end of file)
        start = mls_match.start()
        end = mls_matches[i + 1].start() if i + 1 < len(mls_matches) else len(html)
        section = html[start:end]

        # Address + coordinates
        map_m = map_pattern.search(section)
        if not map_m:
            # Try unescaped ampersands too
            map_m = re.search(r"lat=([\d.]+)&lon=(-?[\d.]+)&address=([^'\"&]+)", section)
        if not map_m:
            print(f"  SKIP MLS# {mls_id}: no address/coordinates found")
            continue

        lat = float(map_m.group(1))
        lon = float(map_m.group(2))
        raw_address = map_m.group(3).strip().rstrip(",").strip()
        # Address comes as "STREET, City, ZIP" — add OR state
        parts = [p.strip() for p in raw_address.split(",")]
        if len(parts) >= 2 and re.match(r"\d{5}", parts[-1]):
            # Insert "OR" before ZIP
            parts.insert(-1, "OR")
        address = ", ".join(parts)

        # Price
        price_m = price_pattern.search(section)
        price = price_m.group(1).replace(",", "") if price_m else ""

        # Bed/bath/sqft
        bb_m = bed_bath_pattern.search(section)
        beds = bb_m.group(1) if bb_m else ""
        full_baths = bb_m.group(2) if bb_m else ""
        half_baths = bb_m.group(3) if bb_m else ""
        baths = full_baths
        if half_baths and half_baths != "0":
            baths = f"{full_baths}.{half_baths}"
        sqft = bb_m.group(4).replace(",", "") if bb_m else ""

        # Photo directory from JavaScript
        photo_m = photo_dir_pattern.search(section)
        if photo_m:
            photo_dir = photo_m.group(1)
            photo_url = f"https://www.rmlsweb.com/webphotos/{photo_dir}{mls_id}-1-a.jpg"
        else:
            photo_url = rmls_photo_url(mls_id)

        # Per-listing RMLS report link (extracted from PhotoViewer CRPT2 token)
        listing_m = listing_link_pattern.search(section)
        if listing_m:
            listing_url = f"https://www.rmlsweb.com/v2/public/report.asp?CRPT2={listing_m.group(2)}"
        else:
            listing_url = ""

        listings.append({
            "address": address,
            "mls": mls_id,
            "lat": lat,
            "lon": lon,
            "price": price,
            "beds": beds,
            "baths": baths,
            "sqft": sqft,
            "photoUrl": photo_url,
            "listingUrl": listing_url,
        })

    return listings


def rmls_photo_url(mls_id):
    """Construct RMLS photo URL from MLS number (fallback)."""
    mls = int(mls_id)
    d1 = (mls // 1000000) * 100000
    d2 = ((mls % 1000000) // 100000) * 10000
    d3 = ((mls % 100000) // 10000) * 1000
    return f"https://www.rmlsweb.com/webphotos/{d1}/{d2:05d}/{d3:04d}/{mls}-1-a.jpg"


def build_notes(listing):
    """Build notes string from listing data."""
    parts = []
    if listing["price"]:
        parts.append(f"${int(listing['price']):,}")
    if listing["beds"]:
        parts.append(f"{listing['beds']} bed")
    if listing["baths"]:
        parts.append(f"{listing['baths']} bath")
    if listing["sqft"]:
        parts.append(f"{int(listing['sqft']):,} sqft")
    if listing["mls"]:
        parts.append(f"MLS# {listing['mls']}")
    return " | ".join(parts)


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    if dry_run:
        args.remove("--dry-run")

    if not args:
        print("Usage: python import-rmls.py [--dry-run] <url-or-file>")
        print()
        print("  url-or-file  RMLS complete list URL or path to local HTML file")
        print("  --dry-run    Parse and preview only, no upload")
        print()
        print("Recommended workflow:")
        print("  1. python fetch-rmls.py <url>       # saves to /tmp/rmls-dump.html")
        print("  2. python import-rmls.py --dry-run /tmp/rmls-dump.html  # preview")
        print("  3. python import-rmls.py /tmp/rmls-dump.html            # import")
        sys.exit(1)

    source = args[0]
    start_time = time.time()

    # Step 1: Get HTML
    if os.path.isfile(source):
        print(f"[1/4] Reading local file: {source}")
        with open(source, encoding="utf-8", errors="replace") as f:
            html = f.read()
        print(f"  {len(html):,} bytes")
    else:
        print(f"[1/4] Fetching RMLS page (timeout {NETWORK_TIMEOUT}s)...")
        try:
            html = fetch_rmls_page(source)
            print(f"  {len(html):,} bytes")
        except Exception as e:
            print(f"  FAILED: {e}")
            print("  Tip: use fetch-rmls.py to save the page locally first")
            sys.exit(1)

    # Step 2: Parse listings (no geocoding needed — lat/lon are in the HTML)
    print(f"[2/4] Parsing listings...")
    listings = parse_listings(html)
    print(f"  Found {len(listings)} listings (coordinates extracted from HTML, no geocoding needed)")

    if not listings:
        print("\nNo listings found! The page format may have changed.")
        sys.exit(1)

    # Show preview
    print(f"\n{'='*70}")
    print(f"  PARSED LISTINGS: {len(listings)}")
    print(f"{'='*70}")
    for i, l in enumerate(listings, 1):
        price_str = f"${int(l['price']):,}" if l['price'] else "no price"
        print(f"  {i:3}. {l['address']}")
        print(f"       {price_str} | {l['beds']}bd/{l['baths']}ba | {l['sqft']} sqft | MLS# {l['mls']} | ({l['lat']:.4f}, {l['lon']:.4f})")
    print(f"{'='*70}\n")

    # Save parsed listings to temp file
    parsed_file = os.path.join(tempfile.gettempdir(), "rmls-parsed.json")
    with open(parsed_file, "w") as f:
        json.dump(listings, f, indent=2)
    print(f"  Parsed listings saved to {parsed_file}")

    if dry_run:
        elapsed = time.time() - start_time
        print(f"\n  Dry run complete in {elapsed:.1f}s. Review the listings above.")
        print(f"  To import: python import-rmls.py {source}")
        return

    # Step 3: Download current properties and deduplicate
    print(f"\n[3/4] Downloading current properties from blob storage...")
    try:
        data = download_blob()
    except Exception as e:
        print(f"  FAILED: {e}")
        print("  Make sure you're logged in: az login")
        sys.exit(1)

    existing_addresses = {p["address"].upper().split(",")[0].strip() for p in data["properties"]}
    print(f"  {len(data['properties'])} existing properties")

    new_listings = []
    skipped = []
    now = datetime.now(timezone.utc).isoformat()

    for l in listings:
        short = l["address"].upper().split(",")[0].strip()
        if short in existing_addresses:
            skipped.append(l["address"])
        else:
            prop = {
                "id": str(uuid.uuid4()),
                "address": l["address"],
                "lat": l["lat"],
                "lng": l["lon"],
                "notes": build_notes(l),
                "checklist": {},
                "status": "interested",
                "listingUrl": l.get("listingUrl", ""),
                "photoUrl": l["photoUrl"],
                "addedAt": now,
                "updatedAt": now,
            }
            new_listings.append(prop)
            existing_addresses.add(short)

    print(f"  {len(new_listings)} new, {len(skipped)} duplicates skipped")

    if skipped:
        print(f"  Skipped duplicates:")
        for addr in skipped[:5]:
            print(f"    - {addr}")
        if len(skipped) > 5:
            print(f"    ... and {len(skipped) - 5} more")

    if not new_listings:
        print("\nNothing new to add!")
        return

    # Add new properties
    for i, prop in enumerate(new_listings, 1):
        data["properties"].append(prop)
        progress(i, len(new_listings), prop["address"])

    # Step 4: Upload
    print(f"\n[4/4] Uploading {len(data['properties'])} total properties...")
    try:
        upload_blob(data)
    except Exception as e:
        backup = os.path.join(tempfile.gettempdir(), "properties_backup.json")
        with open(backup, "w") as f:
            json.dump(data, f)
        print(f"  UPLOAD FAILED: {e}")
        print(f"  Data saved to {backup} - retry manually")
        sys.exit(1)

    elapsed = time.time() - start_time
    print(f"\nDone! Added {len(new_listings)} properties in {elapsed:.1f}s")
    print(f"Total properties: {len(data['properties'])}")


if __name__ == "__main__":
    main()
