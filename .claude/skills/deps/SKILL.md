---
name: deps  
description: 依存関係の更新チェック・セキュリティ監査 (Rust + Node)  
argument-hint: "[rust|node|audit|all]"  
---

Ember プロジェクトの依存関係を確認する。引数で対象を選択:  

- `rust` — `cargo update --dry-run` で更新可能なRust依存を表示。`cargo outdated` がインストール済みならそちらを優先。
- `node` — `cd apps/desktop && npm outdated` でNode依存を表示
- `audit` — セキュリティ監査のみ:
  - `cargo audit` (インストール済みの場合) を実行
  - `cd apps/desktop && npm audit` を実行
- `all` (引数なしの場合のデフォルト) — rust, node, audit の順に全て実行

ツール (`cargo-outdated`, `cargo-audit`) が未インストールの場合はスキップし、インストールコマンドを案内する。  
依存の更新やインストールは行わない。(確認のみ)  
