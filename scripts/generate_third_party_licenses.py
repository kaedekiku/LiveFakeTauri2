#!/usr/bin/env python3
"""
配布物 (livefake.exe) に組み込まれている第三者ライブラリのライセンス一覧
apps/desktop/public/THIRD_PARTY_LICENSES.txt を生成する。

- Rust: `cargo metadata` (Windows x64 向け) で livefake から通常依存をたどる。
  build-dependencies / dev-dependencies と、コンパイル時にだけ使われる proc-macro クレートは
  exe に含まれないため除外する。
- npm: apps/desktop/package.json の dependencies (devDependencies を除く) を node_modules からたどる。
- 各パッケージに同梱されている LICENSE / NOTICE / COPYING 等をそのまま収録する。
  ライセンスファイルを同梱していないパッケージだけ、scripts/license-texts/ の標準文を使う。
- 同一のライセンス本文はまとめて1回だけ載せる。

使い方:
  python scripts/generate_third_party_licenses.py          # 生成
  python scripts/generate_third_party_licenses.py --check  # 最新か確認 (差分があれば終了コード1)

依存ライブラリを追加・更新したら生成し直してコミットすること。
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "apps" / "desktop"
OUT = DESKTOP / "public" / "THIRD_PARTY_LICENSES.txt"
TEXTS = ROOT / "scripts" / "license-texts"
TARGET = "x86_64-pc-windows-msvc"
LICENSE_FILE_PREFIXES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "COPYRIGHT", "UNLICENSE")
# ライセンスファイルが無いときに使う標準文の優先順 (OR のときは先頭に近いものを選ぶ)
FALLBACK_ORDER = ("MIT", "Apache-2.0", "BSD-3-Clause", "MPL-2.0")
RULE = "=" * 78
SUBRULE = "-" * 78


def read_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8", errors="replace").lstrip("﻿")
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return "\n".join(lines).strip("\n")


def license_files(directory: Path) -> list[Path]:
    return sorted(
        (p for p in directory.iterdir() if p.is_file() and p.name.upper().startswith(LICENSE_FILE_PREFIXES)),
        key=lambda p: p.name.upper(),
    )


def fallback_texts(name: str, expr: str, authors: list[str]) -> list[tuple[str, str]]:
    ids = re.findall(r"[A-Za-z0-9.\-]+", expr.replace("/", " OR "))
    ids = [i for i in ids if i not in ("OR", "AND", "WITH")]
    if " AND " in expr:
        chosen = [i for i in FALLBACK_ORDER if i in ids]
    else:
        chosen = [next((i for i in FALLBACK_ORDER if i in ids), "")]
    owner = ", ".join(re.sub(r"\s*<[^>]*>", "", a).strip() for a in authors if a.strip()) or f"the {name} authors"
    result = []
    for spdx in chosen:
        if not spdx:
            raise SystemExit(f"標準文が用意されていないライセンスです: {name} ({expr})")
        body = read_text(TEXTS / f"{spdx}.txt").replace("{copyright}", f"Copyright (c) {owner}")
        result.append((f"{spdx} (標準文)", body))
    return result


def collect_rust() -> list[dict]:
    raw = subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--locked", "--filter-platform", TARGET],
        cwd=ROOT, check=True, capture_output=True,
    ).stdout
    meta = json.loads(raw)
    packages = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    workspace = set(meta["workspace_members"])
    root = next(i for i in workspace if packages[i]["name"] == "livefake")

    def is_proc_macro(pkg: dict) -> bool:
        return any("proc-macro" in t["kind"] for t in pkg["targets"])

    seen: set[str] = set()
    stack = [root]
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        if is_proc_macro(packages[pid]):
            continue
        for dep in nodes[pid]["deps"]:
            if any(kind["kind"] is None for kind in dep["dep_kinds"]):
                stack.append(dep["pkg"])

    result = []
    for pid in seen:
        pkg = packages[pid]
        if pid in workspace or is_proc_macro(pkg):
            continue
        directory = Path(pkg["manifest_path"]).parent
        files = license_files(directory)
        if pkg.get("license_file"):
            extra = directory / pkg["license_file"]
            if extra.is_file() and extra not in files:
                files.append(extra)
        expr = pkg.get("license") or "(license_file を参照)"
        texts = [(f.name, read_text(f)) for f in files]
        if not texts:
            texts = fallback_texts(pkg["name"], expr, pkg.get("authors") or [])
        result.append({
            "kind": "Rust",
            "name": pkg["name"],
            "version": pkg["version"],
            "license": expr,
            "source": f"https://crates.io/crates/{pkg['name']}/{pkg['version']}",
            "repository": pkg.get("repository") or "",
            "texts": texts,
        })
    return result


def collect_npm() -> list[dict]:
    manifest = json.loads((DESKTOP / "package.json").read_text(encoding="utf-8"))
    result: dict[str, dict] = {}

    def resolve(name: str, base: Path) -> Path:
        # Node の解決順と同様に、依存元の node_modules から上位へ探す
        current = base
        while True:
            candidate = current / "node_modules" / name
            if (candidate / "package.json").is_file():
                return candidate
            if current == DESKTOP or current.parent == current:
                raise SystemExit(f"node_modules に見つかりません: {name} (npm ci を実行してください)")
            current = current.parent
            if current.name == "node_modules":
                current = current.parent

    def visit(name: str, base: Path) -> None:
        directory = resolve(name, base)
        pkg = json.loads((directory / "package.json").read_text(encoding="utf-8"))
        key = f"{pkg['name']}@{pkg['version']}"
        if key in result:
            return
        expr = pkg.get("license") or ""
        if isinstance(expr, dict):
            expr = expr.get("type", "")
        texts = [(f.name, read_text(f)) for f in license_files(directory)]
        if not texts:
            author = pkg.get("author")
            authors = [author.get("name", "")] if isinstance(author, dict) else ([author] if author else [])
            texts = fallback_texts(pkg["name"], expr, authors)
        repo = pkg.get("repository") or ""
        if isinstance(repo, dict):
            repo = repo.get("url", "")
        result[key] = {
            "kind": "npm",
            "name": pkg["name"],
            "version": pkg["version"],
            "license": expr,
            "source": f"https://www.npmjs.com/package/{pkg['name']}/v/{pkg['version']}",
            "repository": repo,
            "texts": texts,
        }
        for dep in sorted((pkg.get("dependencies") or {}).keys()):
            visit(dep, directory)

    for dep in sorted((manifest.get("dependencies") or {}).keys()):
        visit(dep, DESKTOP)
    return list(result.values())


def render(packages: list[dict]) -> str:
    packages.sort(key=lambda p: (p["kind"] != "npm", p["name"].lower(), p["version"]))
    out: list[str] = []
    out += [
        "LiveFake サードパーティライセンス / Third-Party Licenses",
        RULE,
        "",
        "このファイルは、LiveFake の配布物 (livefake.exe) に組み込まれている第三者製ソフトウェアの",
        "一覧と、それぞれのライセンス本文・著作権表示をまとめたものです。",
        "LiveFake 本体のライセンスは同梱の LICENSE.txt (MIT License) を参照してください。",
        "",
        "This file lists the third-party software included in the LiveFake distribution",
        "(livefake.exe) together with their license texts and copyright notices.",
        "For the license of LiveFake itself, see the bundled LICENSE.txt (MIT License).",
        "",
        "・複数のライセンスから選べるもの (例: MIT OR Apache-2.0) は、同梱されているライセンスファイルを",
        "  すべて掲載しています。",
        "・Mozilla Public License 2.0 (MPL-2.0) のソフトウェアは改変せずに使用しています。",
        "  ソースコードは下記「MPL-2.0 ソフトウェアのソースコード」に記載の入手先から取得できます。",
        "・ライセンスファイルを同梱していないパッケージには、宣言されたライセンスの標準文を掲載しています",
        "  (「標準文」と表記)。正式な著作権表示は各パッケージの配布元を参照してください。",
        "",
        f"収録数: npm {sum(p['kind'] == 'npm' for p in packages)} 件 / Rust {sum(p['kind'] == 'Rust' for p in packages)} 件",
        "",
        "",
        "一覧 / Package list",
        RULE,
    ]
    for kind in ("npm", "Rust"):
        out += ["", f"[{kind}]"]
        for p in (p for p in packages if p["kind"] == kind):
            out.append(f"  {p['name']} {p['version']}  —  {p['license']}")

    mpl = [p for p in packages if "MPL-2.0" in p["license"]]
    if mpl:
        out += ["", "", "MPL-2.0 ソフトウェアのソースコード / Source code of MPL-2.0 software", RULE, ""]
        for p in mpl:
            out.append(f"  {p['name']} {p['version']}")
            out.append(f"    {p['source']}")
            if p["repository"]:
                out.append(f"    {p['repository']}")

    groups: dict[str, dict] = {}
    for p in packages:
        for label, body in p["texts"]:
            key = re.sub(r"\s+", " ", body).strip()
            group = groups.setdefault(key, {"body": body, "users": []})
            group["users"].append(f"{p['name']} {p['version']} ({label})")

    out += ["", "", "ライセンス本文 / License texts", RULE]
    ordered = sorted(groups.values(), key=lambda g: (g["users"][0].lower()))
    for group in ordered:
        out += ["", SUBRULE, "対象 / Used by:"]
        out += [f"  {u}" for u in sorted(set(group["users"]), key=str.lower)]
        out += [SUBRULE, "", group["body"], ""]
    return "\n".join(out).rstrip("\n") + "\n"


def main() -> int:
    # GitHub Actions の Windows ランナーなどコンソールが cp1252 の環境でも日本語の表示で落ちないようにする
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="生成結果が既存ファイルと一致するか確認するだけ")
    args = parser.parse_args()
    text = render(collect_npm() + collect_rust())
    if args.check:
        # Windows の git (core.autocrlf) で改行が CRLF になっていても一致とみなす
        current = OUT.read_text(encoding="utf-8").replace("\r\n", "\n") if OUT.is_file() else ""
        if current != text:
            print(f"{OUT.relative_to(ROOT)} が最新ではありません。生成し直してください。", file=sys.stderr)
            # どこが違うかをログに残す (CI で原因を追えるように、最初の差分の周辺だけ)
            diff = list(difflib.unified_diff(current.split("\n"), text.split("\n"), "committed", "generated", n=2, lineterm=""))
            for line in diff[:40]:
                print(line, file=sys.stderr)
            return 1
        print(f"{OUT.relative_to(ROOT)} は最新です。")
        return 0
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(text.encode('utf-8')):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
