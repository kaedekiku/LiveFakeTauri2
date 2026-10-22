#!/usr/bin/env python3
"""
Validate latest.json structure and values.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


REQUIRED_TOP = ["version", "released_at", "download_page_url", "platforms"]
REQUIRED_PLATFORM_KEYS = ["sha256", "size", "filename"]
REQUIRED_PLATFORMS = ["windows-x64"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate latest.json")
    parser.add_argument(
        "--file",
        default="apps/landing/public/latest.json",
        help="Path to latest.json (default: apps/landing/public/latest.json)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail when placeholder values are detected",
    )
    return parser.parse_args()


def fail(msg: str) -> int:
    print(f"NG: {msg}")
    return 1


def main() -> int:
    args = parse_args()
    path = Path(args.file).expanduser().resolve()
    if not path.exists():
        return fail(f"file not found: {path}")

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return fail(f"invalid json: {e}")

    if not isinstance(payload, dict):
        return fail("top-level JSON must be object")

    for key in REQUIRED_TOP:
        if key not in payload:
            return fail(f"missing top-level key: {key}")

    platforms = payload.get("platforms")
    if not isinstance(platforms, dict):
        return fail("platforms must be object")

    for platform_key in REQUIRED_PLATFORMS:
        if platform_key not in platforms:
            return fail(f"missing platform: {platform_key}")
        entry = platforms[platform_key]
        if not isinstance(entry, dict):
            return fail(f"platform entry must be object: {platform_key}")
        for field in REQUIRED_PLATFORM_KEYS:
            if field not in entry:
                return fail(f"missing field in {platform_key}: {field}")

        sha256 = entry.get("sha256")
        if not isinstance(sha256, str):
            return fail(f"sha256 must be string: {platform_key}")

        size = entry.get("size")
        if not isinstance(size, int) or size < 0:
            return fail(f"size must be non-negative integer: {platform_key}")

        filename = entry.get("filename")
        if not isinstance(filename, str) or not filename.endswith(".zip"):
            return fail(f"filename must be .zip string: {platform_key}")

        # Template placeholder is allowed in non-strict mode.
        if sha256 == "" and size == 0 and not args.strict:
            continue

        if len(sha256) != 64:
            return fail(f"sha256 must be 64-char hex string: {platform_key}")
        if any(ch not in "0123456789abcdef" for ch in sha256.lower()):
            return fail(f"sha256 has non-hex chars: {platform_key}")

    notice = payload.get("notice")
    if notice is not None:
        if not isinstance(notice, dict):
            return fail("notice must be object")
        nid, below, text = notice.get("id"), notice.get("below"), notice.get("text")
        if not isinstance(nid, str) or not nid or len(nid) > 64 or any(not (c.isascii() and (c.isalnum() or c in "._-")) for c in nid):
            return fail("notice.id must be 1-64 chars of [A-Za-z0-9._-]")
        if not isinstance(below, str) or not all(p.isdigit() for p in below.split(".")):
            return fail("notice.below must be a version like 0.0.122")
        if not isinstance(text, str) or not text.strip() or len(text) > 300:
            return fail("notice.text must be a non-empty string up to 300 chars")

    print(f"OK: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
