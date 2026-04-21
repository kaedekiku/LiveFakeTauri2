#!/usr/bin/env python3
"""
Generate latest.json for app update checks.

Usage example:
  python scripts/generate_latest_json.py \
    --version 0.2.0 \
    --released-at 2026-03-07T15:30:00+09:00 \
    --download-page-url https://github.com/kaedekiku/LiveFakeTauri2/releases/tag/v0.2.0 \
    --windows-zip C:\\path\\livefake-win-x64.zip \
    --out C:\\path\\public\\latest.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_platform_entry(zip_path: Path) -> dict:
    return {
        "sha256": sha256_file(zip_path),
        "size": zip_path.stat().st_size,
        "filename": zip_path.name,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate latest.json metadata.")
    parser.add_argument("--version", required=True, help="Release version, e.g. 0.2.0")
    parser.add_argument("--released-at", required=True, help="Release datetime in ISO8601")
    parser.add_argument("--download-page-url", required=True, help="Public GitHub release page URL")
    parser.add_argument("--windows-zip", required=True, help="Path to windows x64 ZIP")
    parser.add_argument(
        "--out",
        default="apps/landing/public/latest.json",
        help="Output latest.json path (default: apps/landing/public/latest.json)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    windows_zip = Path(args.windows_zip).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()

    if not windows_zip.exists():
        raise FileNotFoundError(f"windows zip not found: {windows_zip}")

    payload = {
        "version": args.version,
        "released_at": args.released_at,
        "download_page_url": args.download_page_url,
        "platforms": {
            "windows-x64": build_platform_entry(windows_zip),
        },
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"written: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
