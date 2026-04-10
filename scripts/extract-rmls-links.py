#!/usr/bin/env python3
"""Extract RMLS report links from privateemail IMAP.

Usage: python extract-rmls-links.py
"""

import imaplib
import getpass
import re

HOST = "mail.privateemail.com"
USER = "nelson@romaine.life"

pwd = getpass.getpass(f"Password for {USER}: ")
imap = imaplib.IMAP4_SSL(HOST)
imap.login(USER, pwd)
print("Connected\n")

all_links = {}

for folder in ["INBOX", "Archive"]:
    imap.select(f'"{folder}"', readonly=True)
    status, nums = imap.search(None, 'FROM', '"rmls"')
    if status != "OK" or not nums[0]:
        print(f"{folder}: no RMLS emails")
        continue

    msgs = nums[0].split()
    print(f"{folder}: {len(msgs)} RMLS emails")

    for num in msgs:
        status, data = imap.fetch(num, "(BODY[HEADER.FIELDS (SUBJECT DATE)] BODY[TEXT])")
        if status != "OK":
            continue

        subject = ""
        date = ""
        links = []

        for part in data:
            if isinstance(part, tuple):
                text = part[1].decode("utf-8", errors="replace")
                if "Subject:" in text:
                    subject = text.split("Subject:")[-1].strip().split("\r\n")[0]
                if "Date:" in text:
                    date = text.split("Date:")[-1].strip().split("\r\n")[0]
                # Find all rmlsweb report links
                found = re.findall(r'https?://www\.rmlsweb\.com/v2/public/report\.asp[^\s"<>\']+', text)
                for link in found:
                    link = link.split('"')[0].split("'")[0].split(")")[0]
                    # Unescape HTML entities
                    link = link.replace("&amp;", "&")
                    links.append(link)

        for link in links:
            if link not in all_links:
                # Classify: type=AE is "all entries" (complete list), type=NE is "new entries"
                link_type = "complete list" if "type=AE" in link else "newest matches" if "type=NE" in link else "unknown"
                all_links[link] = {"subject": subject, "date": date, "type": link_type}

print(f"\nFound {len(all_links)} unique RMLS links:\n")
for link, info in all_links.items():
    print(f"  [{info['type']}] {info['date']}")
    print(f"    Subject: {info['subject']}")
    print(f"    {link}")
    print()

imap.logout()
