#!/usr/bin/env python3
"""Extract Redfin listing links from privateemail IMAP.

Usage: python extract-redfin-links.py
"""

import imaplib
import getpass
import re
import email
from email.header import decode_header

HOST = "mail.privateemail.com"
USER = "nelson@romaine.life"

pwd = getpass.getpass(f"Password for {USER}: ")
imap = imaplib.IMAP4_SSL(HOST)
imap.login(USER, pwd)
print("Connected")

# Search all folders for Redfin emails
for folder in ["INBOX", "Archive"]:
    imap.select(f'"{folder}"', readonly=True)
    status, nums = imap.search(None, 'FROM', '"redfin"')
    if status != "OK" or not nums[0]:
        print(f"{folder}: no Redfin emails")
        continue

    msgs = nums[0].split()
    print(f"\n{folder}: {len(msgs)} Redfin emails\n")

    all_links = set()
    for num in msgs:
        status, data = imap.fetch(num, "(BODY[HEADER.FIELDS (SUBJECT DATE)] BODY[TEXT])")
        if status != "OK":
            continue

        # Get subject
        subject = ""
        for part in data:
            if isinstance(part, tuple):
                text = part[1].decode("utf-8", errors="replace")
                if "Subject:" in text:
                    subject = text.split("Subject:")[-1].strip().split("\r\n")[0]
                # Find Redfin property links
                links = re.findall(r'https?://www\.redfin\.com/OR/[^\s"<>\']+', text)
                for link in links:
                    # Clean up URL encoding artifacts
                    link = link.split('"')[0].split("'")[0].split(")")[0]
                    if "/home/" in link:
                        all_links.add(link)

        if subject:
            print(f"  Subject: {subject}")

    print(f"\n  Unique property links: {len(all_links)}")
    for link in sorted(all_links):
        print(f"    {link}")

imap.logout()
