#!/usr/bin/env python3
"""Import RMLS listings from a complete list URL into house-hunt blob storage.

Usage:
    python import-rmls.py <rmls-complete-list-url>

Requires: az cli logged in with blob access to househuntdata storage account.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone


STORAGE_ACCOUNT = "househuntdata"
CONTAINER = "properties"
BLOB_NAME = "properties.json"

# Azure Maps for geocoding
MAPS_RESOURCE = "https://atlas.microsoft.com"
MAPS_CLIENT_ID = "9d0ec021-ed28-4a1b-9760-27542745c033"


def az_get_token(resource):
    """Get an Azure access token for the given resource."""
    result = subprocess.run(
        ["az", "account", "get-access-token", "--resource", resource, "--query", "accessToken", "-o", "tsv"],
        capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


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
        capture_output=True, check=True
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
        capture_output=True, check=True
    )


def fetch_rmls_page(url):
    """Fetch the RMLS page HTML."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_listings(html):
    """Parse listings from RMLS complete list HTML."""
    listings = []

    # Find all property blocks - RMLS uses table-based layout
    # Look for MLS numbers and addresses
    mls_pattern = re.compile(r'MLS[#\s]*[:.]?\s*(\d{6,10})', re.IGNORECASE)

    # Find address blocks with state pattern
    addr_pattern = re.compile(
        r'(\d+\s+[A-Z0-9\s.]+(?:ST|AVE|DR|LN|CT|PL|RD|WAY|BLVD|CIR|TER|PKWY|HWY)\.?)\s*,?\s*'
        r'([A-Za-z\s]+),\s*(OR)\s+(\d{5})',
        re.IGNORECASE
    )

    # Price pattern
    price_pattern = re.compile(r'\$\s*([\d,]+)')

    # Bed/bath/sqft pattern
    bed_bath_pattern = re.compile(r'(\d+)\s*(?:bed|br|bd)', re.IGNORECASE)
    bath_pattern = re.compile(r'(\d+)\s*(?:bath|ba|bt)', re.IGNORECASE)
    sqft_pattern = re.compile(r'([\d,]+)\s*(?:sq\s*ft|sqft|sf)', re.IGNORECASE)

    # Split HTML into property sections using MLS numbers as anchors
    mls_matches = list(mls_pattern.finditer(html))

    if not mls_matches:
        print("  No MLS numbers found, trying alternative parsing...")
        # Try finding addresses directly
        for addr_match in addr_pattern.finditer(html):
            street = addr_match.group(1).strip()
            city = addr_match.group(2).strip()
            state = addr_match.group(3)
            zipcode = addr_match.group(4)
            address = f"{street}, {city}, {state} {zipcode}"

            # Look for price nearby
            start = max(0, addr_match.start() - 500)
            end = min(len(html), addr_match.end() + 500)
            context = html[start:end]

            price_m = price_pattern.search(context)
            price = price_m.group(1).replace(",", "") if price_m else ""

            bed_m = bed_bath_pattern.search(context)
            bath_m = bath_pattern.search(context)
            sqft_m = sqft_pattern.search(context)

            listings.append({
                "address": address,
                "mls": "",
                "price": price,
                "beds": bed_m.group(1) if bed_m else "",
                "baths": bath_m.group(1) if bath_m else "",
                "sqft": sqft_m.group(1).replace(",", "") if sqft_m else "",
            })
        return listings

    for i, mls_match in enumerate(mls_matches):
        mls_id = mls_match.group(1)

        # Get the section of HTML around this MLS number
        start = max(0, mls_match.start() - 2000)
        end = mls_matches[i + 1].start() if i + 1 < len(mls_matches) else min(len(html), mls_match.end() + 2000)
        section = html[start:end]

        # Find address in this section
        addr_match = addr_pattern.search(section)
        if not addr_match:
            continue

        street = addr_match.group(1).strip()
        city = addr_match.group(2).strip()
        state = addr_match.group(3)
        zipcode = addr_match.group(4)
        address = f"{street}, {city}, {state} {zipcode}"

        # Find price
        price_m = price_pattern.search(section)
        price = price_m.group(1).replace(",", "") if price_m else ""

        # Find bed/bath/sqft
        bed_m = bed_bath_pattern.search(section)
        bath_m = bath_pattern.search(section)
        sqft_m = sqft_pattern.search(section)

        listings.append({
            "address": address,
            "mls": mls_id,
            "price": price,
            "beds": bed_m.group(1) if bed_m else "",
            "baths": bath_m.group(1) if bath_m else "",
            "sqft": sqft_m.group(1).replace(",", "") if sqft_m else "",
        })

    return listings


def rmls_photo_url(mls_id):
    """Construct RMLS photo URL from MLS number."""
    mls = int(mls_id)
    d1 = (mls // 1000000) * 100000
    d2 = ((mls % 1000000) // 100000) * 10000
    d3 = ((mls % 100000) // 10000) * 1000
    # d2 needs 5-digit padding, d3 needs 4-digit padding
    return f"https://www.rmlsweb.com/webphotos/{d1}/{d2:05d}/{d3:04d}/{mls}-1-a.jpg"


def geocode(address, token):
    """Geocode an address using Azure Maps."""
    encoded = urllib.parse.quote(address)
    url = f"https://atlas.microsoft.com/search/address/json?api-version=1.0&query={encoded}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "x-ms-client-id": MAPS_CLIENT_ID,
    })
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    if data.get("results"):
        pos = data["results"][0]["position"]
        full_addr = data["results"][0].get("address", {}).get("freeformAddress", address)
        return pos["lat"], pos["lon"], full_addr
    return None, None, address


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
    if len(sys.argv) < 2:
        print("Usage: python import-rmls.py <rmls-complete-list-url>")
        sys.exit(1)

    url = sys.argv[1]
    print(f"Fetching RMLS page...")
    html = fetch_rmls_page(url)
    print(f"  Page size: {len(html):,} bytes")

    print("Parsing listings...")
    listings = parse_listings(html)
    print(f"  Found {len(listings)} listings")

    if not listings:
        print("No listings found! The page format may have changed.")
        sys.exit(1)

    print("\nDownloading current properties...")
    data = download_blob()
    existing_addresses = {p["address"].upper().split(",")[0].strip() for p in data["properties"]}
    print(f"  {len(data['properties'])} existing properties")

    # Deduplicate
    new_listings = []
    for l in listings:
        short = l["address"].upper().split(",")[0].strip()
        if short not in existing_addresses:
            new_listings.append(l)

    print(f"  {len(new_listings)} new listings after dedup")

    if not new_listings:
        print("Nothing new to add!")
        return

    # Geocode new listings
    print("\nGeocoding...")
    maps_token = az_get_token(MAPS_RESOURCE)
    now = datetime.now(timezone.utc).isoformat()

    for i, listing in enumerate(new_listings, 1):
        lat, lng, full_addr = geocode(listing["address"], maps_token)
        if lat is None:
            print(f"  [{i}/{len(new_listings)}] FAILED: {listing['address']}")
            continue

        photo_url = rmls_photo_url(listing["mls"]) if listing["mls"] else ""

        prop = {
            "id": str(uuid.uuid4()),
            "address": full_addr,
            "lat": lat,
            "lng": lng,
            "notes": build_notes(listing),
            "checklist": {},
            "status": "interested",
            "listingUrl": "",
            "photoUrl": photo_url,
            "addedAt": now,
            "updatedAt": now,
        }
        data["properties"].append(prop)
        existing_addresses.add(full_addr.upper().split(",")[0].strip())
        print(f"  [{i}/{len(new_listings)}] {full_addr}")

    print(f"\nUploading {len(data['properties'])} total properties...")
    upload_blob(data)
    print("Done!")


if __name__ == "__main__":
    main()
