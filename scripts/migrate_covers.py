#!/usr/bin/env python3
"""
migrate_covers.py — one-off: move covers/<file> into covers/<category>/<file>
and update the `cover` field of every entry that points at it.

Usage:
    python scripts/migrate_covers.py            # dry run (default): only print the plan
    python scripts/migrate_covers.py --apply    # really move files and rewrite data/*.json

Safe to run more than once: entries already under covers/<category>/ are skipped.
Files are moved byte-for-byte (git mv inside a Git repo, so Git records a rename).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys

from common import (
    CATEGORIES, COVERS_DIR, DATA_DIR, ROOT, Colors, load_entries, save_entries, setup_console,
)

C = Colors


def in_git_repo() -> bool:
    try:
        out = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=ROOT,
                             capture_output=True, text=True)
    except FileNotFoundError:  # git not installed
        return False
    return out.returncode == 0 and out.stdout.strip() == "true"


def is_tracked(rel: str) -> bool:
    out = subprocess.run(["git", "ls-files", "--error-unmatch", rel], cwd=ROOT, capture_output=True)
    return out.returncode == 0


def move(src_rel: str, dst_rel: str, use_git: bool) -> None:
    (ROOT / dst_rel).parent.mkdir(parents=True, exist_ok=True)
    if use_git and is_tracked(src_rel):
        subprocess.run(["git", "mv", src_rel, dst_rel], cwd=ROOT, check=True)
    else:
        shutil.move(str(ROOT / src_rel), str(ROOT / dst_rel))


def main() -> int:
    setup_console()
    parser = argparse.ArgumentParser(description="Move covers into per-category folders.")
    parser.add_argument("--apply", action="store_true", help="really move files and rewrite JSON")
    parser.add_argument("--dry-run", action="store_true", help="only print the plan (default)")
    args = parser.parse_args()
    apply = args.apply and not args.dry_run

    use_git = in_git_repo()
    print(C.bold(f"\nMigrate covers — {'APPLY' if apply else 'DRY RUN'}") +
          C.dim(f"   (move with {'git mv' if use_git else 'shutil.move'})\n"))

    moved: dict[str, str] = {}  # old relative path -> new relative path (each file moved once)
    referenced: set[str] = set()
    problems: list[str] = []
    updated = skipped = 0

    for category in CATEGORIES:
        entries = load_entries(category)
        changed = False
        for entry in entries:
            label = f"{category}/{entry.get('id', '?')}"
            cover = entry.get("cover")
            if not isinstance(cover, str) or not cover:
                continue
            referenced.add(cover)
            parts = cover.split("/")
            if len(parts) != 2 or parts[0] != "covers":
                skipped += 1  # already in a subfolder (or not a covers/ path at all)
                continue

            if cover in moved:  # same image used by several entries: moved once, update all
                new = moved[cover]
            else:
                new = f"covers/{category}/{parts[1]}"
                if not (ROOT / cover).is_file():
                    problems.append(f"{label}: file not found: {cover} (entry left unchanged)")
                    skipped += 1
                    continue
                if (ROOT / new).exists():
                    problems.append(f"{label}: target already exists: {new} (not overwritten, entry left unchanged)")
                    skipped += 1
                    continue
                print(f"  move   {cover}  →  {new}")
                if apply:
                    move(cover, new, use_git)
                moved[cover] = new
            if not new.startswith(f"covers/{category}/"):
                problems.append(f"{label}: shares {cover} with another category; now points to {new}")
            print(C.dim(f"  update {label}: cover = {new}"))
            entry["cover"] = new
            referenced.add(new)
            updated += 1
            changed = True
        if changed and apply:
            save_entries(category, entries)

    # Loose images in covers/ that no entry references: list only, never moved.
    orphans = [f.name for f in sorted(COVERS_DIR.iterdir())
               if f.is_file() and not f.name.startswith(".")
               and f"covers/{f.name}" not in referenced] if COVERS_DIR.exists() else []
    for name in orphans:
        problems.append(f"covers/{name}: not referenced by any entry (left in place)")

    print(C.bold("\nSummary"))
    print(f"  files moved      {len(moved)}")
    print(f"  entries updated  {updated}")
    print(f"  entries skipped  {skipped}")
    print(f"  problems         {len(problems)}")
    for p in problems:
        print(C.yellow(f"    - {p}"))
    if not apply:
        print(C.dim(f"\n  Dry run: nothing was changed. Run with --apply to move files and rewrite {DATA_DIR.name}/*.json."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
