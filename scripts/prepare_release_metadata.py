#!/usr/bin/env python3
"""
Prepare release metadata in one command:
1) generate latest.json
2) validate latest.json in strict mode
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare strict-validated latest.json for release.")
    parser.add_argument("--version", required=True, help="Release version, e.g. 0.2.0")
    parser.add_argument("--released-at", required=True, help="Release datetime in ISO8601")
    parser.add_argument("--download-page-url", required=True, help="Public GitHub release page URL")
    parser.add_argument("--windows-zip", required=True, help="Path to windows x64 ZIP")
    parser.add_argument(
        "--out",
        default="apps/landing/public/latest.json",
        help="Output latest.json path (default: apps/landing/public/latest.json)",
    )
    # お知らせ (notice) は generate_latest_json.py へそのまま渡す (指定しなければ今のものを引き継ぐ)
    parser.add_argument("--notice-id")
    parser.add_argument("--notice-below")
    parser.add_argument("--notice-text")
    parser.add_argument("--clear-notice", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    py = sys.executable

    gen_script = repo_root / "scripts" / "generate_latest_json.py"
    val_script = repo_root / "scripts" / "validate_latest_json.py"

    run(
        [
            py,
            str(gen_script),
            "--version",
            args.version,
            "--released-at",
            args.released_at,
            "--download-page-url",
            args.download_page_url,
            "--windows-zip",
            args.windows_zip,
            "--out",
            args.out,
        ]
        + (["--notice-id", args.notice_id] if args.notice_id else [])
        + (["--notice-below", args.notice_below] if args.notice_below else [])
        + (["--notice-text", args.notice_text] if args.notice_text else [])
        + (["--clear-notice"] if args.clear_notice else [])
    )

    run([py, str(val_script), "--file", args.out, "--strict"])
    print(f"OK: prepared and validated {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
