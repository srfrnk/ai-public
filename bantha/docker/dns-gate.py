#!/usr/bin/env python3
"""
Lightweight in-container DNS filtering forwarder.
Listens on 127.0.0.1:5300 (or redirected port) and strictly resolves
whitelisted domains against upstream DNS servers while dropping or
returning NXDOMAIN for unauthorized domains.
"""

import socket
import sys
import json
import re

def compile_pattern(pattern):
    if pattern.startswith("regex:"):
        return re.compile(pattern[6:])
    # Glob conversion
    res = "^"
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == '*' and i + 1 < len(pattern) and pattern[i+1] == '*':
            res += ".*"
            i += 2
        elif c == '*':
            res += "[^.]*"
            i += 1
        elif c in r".()+|^$[]{}\\":
            res += "\\" + c
            i += 1
        else:
            res += c
            i += 1
    res += "$"
    return re.compile(res, re.IGNORECASE)

def extract_domain_name(data):
    try:
        # Standard DNS question format
        idx = 12
        parts = []
        while idx < len(data):
            length = data[idx]
            if length == 0:
                break
            idx += 1
            parts.append(data[idx:idx+length].decode('ascii', errors='ignore'))
            idx += length
        return ".".join(parts)
    except Exception:
        return ""

def main():
    if len(sys.argv) < 2:
        sys.exit(0)

    try:
        config = json.loads(sys.argv[1])
    except Exception as e:
        sys.exit(1)

    dns_cfg = config.get("dns", {})
    allowed_patterns = [compile_pattern(p) for p in dns_cfg.get("allowedDomains", [])]
    denied_patterns = [compile_pattern(p) for p in dns_cfg.get("deniedDomains", [])]
    upstream_servers = dns_cfg.get("upstreamServers", ["1.1.1.1", "8.8.8.8"])

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 5300))

    while True:
        try:
            data, addr = sock.recvfrom(4096)
            domain = extract_domain_name(data)
            if not domain:
                continue

            # Check blacklist first
            blocked = False
            for dp in denied_patterns:
                if dp.match(domain):
                    blocked = True
                    break

            if not blocked and allowed_patterns:
                matched_allow = False
                for ap in allowed_patterns:
                    if ap.match(domain):
                        matched_allow = True
                        break
                if not matched_allow:
                    blocked = True

            if blocked:
                # Build simple NXDOMAIN response (Flags: 0x8183)
                if len(data) >= 12:
                    resp = bytearray(data)
                    resp[2] = 0x81
                    resp[3] = 0x83
                    sock.sendto(bytes(resp), addr)
                continue

            # Forward to upstream
            forwarded = False
            for up in upstream_servers:
                try:
                    up_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                    up_sock.settimeout(2.0)
                    up_sock.sendto(data, (up, 53))
                    resp, _ = up_sock.recvfrom(4096)
                    sock.sendto(resp, addr)
                    up_sock.close()
                    forwarded = True
                    break
                except Exception:
                    continue

        except Exception:
            continue

if __name__ == "__main__":
    main()
