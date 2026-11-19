#!/usr/bin/env python3
"""
bundle_codebase.py
==================
Consolidates the entire codebase into a single markdown file (PROJECT_CODEBASE.md)
or unpacks the codebase from PROJECT_CODEBASE.md back into the workspace.

Usage:
  python3 scripts/bundle_codebase.py               # Bundle / update PROJECT_CODEBASE.md
  python3 scripts/bundle_codebase.py --update      # Alias for bundling / updating
  python3 scripts/bundle_codebase.py --check       # Verify PROJECT_CODEBASE.md is in sync
  python3 scripts/bundle_codebase.py --unpack      # Unpack files from PROJECT_CODEBASE.md
"""

import os
import sys
import re
import base64
import argparse
from datetime import datetime

OUTPUT_FILENAME = "PROJECT_CODEBASE.md"

# Directories and files to exclude from bundling
EXCLUDE_DIRS = {
    ".git",
    "node_modules",
    "dist",
    ".qodo",
    ".gemini",
    "__pycache__",
    ".idea",
    ".vscode",
    "coverage",
    ".vercel",
    ".claude",
}

EXCLUDE_FILES = {
    OUTPUT_FILENAME,
    f"{OUTPUT_FILENAME}.tmp",
    ".DS_Store",
    "Thumbs.db",
}

EXCLUDED_ARTIFACT_SUFFIXES = (".pyc", ".log", ".pem", ".key", ".tsbuildinfo")

CATEGORY_ORDER = [
    "1. Project Configuration & Build",
    "2. Core & Shared Definitions",
    "3. Storage & Persistence (IndexedDB / Dexie)",
    "4. Background Service Worker & CDP Interception",
    "5. Extraction, Normalization & Schema Inference Pipeline",
    "6. Cloud Sync (Sphere API Client & Offline Sync Queue)",
    "7. Privacy, Redaction & Source Policy",
    "8. Export Engines (CSV, JSON, JSONL)",
    "9. Dashboard Application (React + Tailwind)",
    "10. SidePanel Extension UI",
    "11. Interactive Demo & Catalog Harness",
    "12. Unit Test Suite (Vitest)",
    "13. Documentation & System Specifications",
    "14. Binary Assets (Extension Icons)",
    "15. Dependency Lockfile",
    "16. Other Project Files",
]


def is_excluded_file(filename: str, rel_path: str = "") -> bool:
    """Exclude generated bundle outputs, env secrets, and temporary artifacts."""
    base = os.path.basename(filename)
    if base in EXCLUDE_FILES or rel_path in EXCLUDE_FILES:
        return True
    if base == ".env" or (base.startswith(".env.") and base != ".env.example"):
        return True
    if base.endswith(EXCLUDED_ARTIFACT_SUFFIXES):
        return True
    return False


def get_workspace_root() -> str:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if os.path.basename(script_dir) == "scripts":
        return os.path.dirname(script_dir)
    return os.path.abspath(".")


def categorize_file(rel_path: str) -> str:
    p = rel_path.replace("\\", "/")
    if p.startswith("public/icons/") or p.endswith((".png", ".ico", ".jpg", ".webp")):
        return "14. Binary Assets (Extension Icons)"
    if p == "package-lock.json":
        return "15. Dependency Lockfile"
    if (
        p
        in {
            "package.json",
            "tsconfig.json",
            "vite.config.ts",
            "tailwind.config.js",
            "postcss.config.js",
            "public/manifest.json",
            ".gitignore",
        }
        or p.startswith("scripts/")
    ):
        return "1. Project Configuration & Build"
    if p.startswith("src/shared/") or p.startswith("src/messaging/"):
        return "2. Core & Shared Definitions"
    if p.startswith("src/data/"):
        return "3. Storage & Persistence (IndexedDB / Dexie)"
    if p.startswith("src/background/") or p.startswith("src/content/"):
        return "4. Background Service Worker & CDP Interception"
    if p.startswith("src/extraction/"):
        return "5. Extraction, Normalization & Schema Inference Pipeline"
    if p.startswith("src/sync/"):
        return "6. Cloud Sync (Sphere API Client & Offline Sync Queue)"
    if p.startswith("src/privacy/"):
        return "7. Privacy, Redaction & Source Policy"
    if p.startswith("src/export/"):
        return "8. Export Engines (CSV, JSON, JSONL)"
    if p == "dashboard.html" or p.startswith("src/styles/") or p.startswith("src/dashboard/"):
        return "9. Dashboard Application (React + Tailwind)"
    if p == "sidepanel.html" or p.startswith("src/sidepanel/"):
        return "10. SidePanel Extension UI"
    if p == "demo.html" or p.startswith("src/demo/"):
        return "11. Interactive Demo & Catalog Harness"
    if p.startswith("tests/"):
        return "12. Unit Test Suite (Vitest)"
    if p.startswith("docs/") or p.endswith(".md"):
        return "13. Documentation & System Specifications"
    return "16. Other Project Files"


def get_language(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    mapping = {
        ".ts": "typescript",
        ".tsx": "tsx",
        ".js": "javascript",
        ".mjs": "javascript",
        ".cjs": "javascript",
        ".py": "python",
        ".sh": "bash",
        ".bash": "bash",
        ".json": "json",
        ".css": "css",
        ".html": "html",
        ".md": "markdown",
        ".yml": "yaml",
        ".yaml": "yaml",
        ".xml": "xml",
        ".svg": "xml",
        ".sql": "sql",
        ".env": "bash",
    }
    if os.path.basename(path) == ".gitignore":
        return "gitignore"
    return mapping.get(ext, "text")


def safe_fence(content: str) -> str:
    """Return a backtick fence strictly longer than any backtick run in content."""
    runs = re.findall(r"`+", content)
    max_run = max((len(r) for r in runs), default=0)
    return "`" * max(5, max_run + 1)


def slugify(text: str) -> str:
    s = (
        text.lower()
        .replace(" ", "-")
        .replace("/", "-")
        .replace(".", "-")
        .replace("&", "and")
    )
    return "".join(c for c in s if c.isalnum() or c in "-")


def build_tree(root_dir: str, current_path: str = "", prefix: str = "") -> list:
    full_current = os.path.join(root_dir, current_path) if current_path else root_dir
    try:
        entries = sorted(os.listdir(full_current))
    except OSError:
        return []

    filtered = []
    for e in entries:
        item_rel = os.path.join(current_path, e) if current_path else e
        full_item_path = os.path.join(root_dir, item_rel)
        if os.path.isdir(full_item_path):
            if e not in EXCLUDE_DIRS:
                filtered.append(e)
        elif not is_excluded_file(e, item_rel.replace("\\", "/")):
            filtered.append(e)

    dirs = [e for e in filtered if os.path.isdir(os.path.join(full_current, e))]
    files = [e for e in filtered if os.path.isfile(os.path.join(full_current, e))]

    items = sorted(dirs) + sorted(files)
    lines = []
    for i, item in enumerate(items):
        is_last = i == len(items) - 1
        connector = "└── " if is_last else "├── "
        item_rel = os.path.join(current_path, item) if current_path else item
        full_item_path = os.path.join(root_dir, item_rel)
        if os.path.isdir(full_item_path):
            lines.append(f"{prefix}{connector}{item}/")
            extension = "    " if is_last else "│   "
            lines.extend(build_tree(root_dir, item_rel, prefix + extension))
        else:
            lines.append(f"{prefix}{connector}{item}")
    return lines


def discover_files(root_dir: str) -> list:
    discovered = []
    for root, dirs, files in os.walk(root_dir):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS)
        for f in sorted(files):
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, root_dir).replace("\\", "/")
            if is_excluded_file(f, rel_path):
                continue
            discovered.append(rel_path)
    return discovered


def sort_key_for_file(rel_path: str):
    category = categorize_file(rel_path)
    cat_index = CATEGORY_ORDER.index(category) if category in CATEGORY_ORDER else 99

    config_prio = [
        "package.json",
        "tsconfig.json",
        "vite.config.ts",
        "tailwind.config.js",
        "postcss.config.js",
        "public/manifest.json",
        ".gitignore",
        "scripts/generate-icons.js",
        "scripts/bundle_codebase.py",
    ]
    if rel_path in config_prio:
        file_prio = config_prio.index(rel_path)
    else:
        file_prio = 100

    return (cat_index, file_prio, rel_path)


def render_bundle_markdown(root_dir: str) -> tuple[str, dict]:
    all_rel_paths = discover_files(root_dir)
    all_rel_paths.sort(key=sort_key_for_file)

    total_files = 0
    total_lines = 0
    total_bytes = 0

    file_records = []
    for rel_p in all_rel_paths:
        full_p = os.path.join(root_dir, rel_p)
        if not os.path.exists(full_p):
            continue
        size = os.path.getsize(full_p)
        is_bin = rel_p.startswith("public/icons/") or rel_p.endswith(
            (".png", ".jpg", ".jpeg", ".ico", ".webp", ".woff", ".woff2")
        )
        line_count = 0
        if not is_bin:
            with open(full_p, "r", encoding="utf-8", errors="replace") as fh:
                line_count = sum(1 for _ in fh)

        total_files += 1
        total_lines += line_count
        total_bytes += size

        file_records.append(
            {
                "category": categorize_file(rel_p),
                "path": rel_p,
                "full_path": full_p,
                "size": size,
                "lines": line_count,
                "is_bin": is_bin,
                "lang": get_language(rel_p),
            }
        )

    proj_name = os.path.basename(root_dir)
    tree_lines = [f"{proj_name}/"] + build_tree(root_dir)
    tree_str = "\n".join(tree_lines)

    output = []
    output.append("# Consolidated Codebase: API Data CSV Extractor (Chrome Extension)")
    output.append("")
    output.append(f"> **Project:** `{proj_name}`  ")
    output.append(f"> **Generated Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ")
    output.append(f"> **Total Tracked Files:** {total_files}  ")
    output.append(f"> **Total Source Lines:** {total_lines:,}  ")
    output.append(
        f"> **Total Source Size:** {total_bytes:,} bytes (~{total_bytes / (1024 * 1024):.2f} MB)  "
    )
    output.append("")
    output.append("---")
    output.append("")

    # Architecture Overview
    output.append("## 1. Project Architecture & System Overview")
    output.append("")
    output.append(
        "The **API Data CSV Extractor** is a Google Chrome Extension (Manifest V3) purpose-built to capture permitted JSON/GraphQL API datasets, export CSV/JSON/JSONL locally, and perform bi-directional POS synchronization with Sphere Pharmacy."
    )
    output.append("")
    output.append("### Key Subsystems:")
    output.append("1. **Network Interception, Polling & Outbound Writeback (`src/background/`, `src/content/`):**")
    output.append(
        "   - Uses Chrome DevTools Protocol (`cdp-adapter.ts`) and Zero-PHI passive content scripts (`main-interceptor.ts`, `isolated-bridge.ts`) alongside 0-indexed GraphQL polling (`bandago-poller.ts`) and idempotent Physical Inventory writebacks (`bandago-writeback.ts`)."
    )
    output.append("2. **Storage & State Machine (`src/data/`):**")
    output.append(
        "   - Client-side persistence powered by `Dexie.js` (IndexedDB) for captured HTTP responses, inferred schemas, extracted tabular records, export audits, and sync status."
    )
    output.append("3. **Extraction & Transformation Engine (`src/extraction/`):**")
    output.append("   - `schema-inference.ts`: Heuristic data type and structural detection.")
    output.append("   - `pagination-detector.ts`: Detects cursor, offset, page, and link header pagination.")
    output.append("   - `bandago-normalizer.ts`: Pharmacy catalog normalizer (FEFO lots, quarantine exclusion, ValidFrom pricing).")
    output.append("   - `flatten.ts`, `deduplicate.ts` & `path-selector.ts`: Deep flattening, dedupe keys, and path filtering.")
    output.append("4. **Export Engine (`src/export/`):**")
    output.append(
        "   - RFC 4180 compliant CSV generator with CSV formula injection sanitization (`sanitize.ts`), JSON, JSON Lines (JSONL), and timestamped filename templates."
    )
    output.append("5. **Cloud Synchronization (`src/sync/`):**")
    output.append("   - `sphere-client.ts`: Authenticated batch sync, server policy sync, and Zero-PHI telemetry client.")
    output.append("   - `sync-queue.ts`: Resilient offline queue with exponential backoff and retry mechanism.")
    output.append("6. **User Interfaces (`src/dashboard/`, `src/sidepanel/`, `src/demo/`):**")
    output.append("   - React 18 + Tailwind CSS + Lucide Icons + Vite.")
    output.append(
        "   - Dashboard (`dashboard.html`), Chrome Side Panel (`sidepanel.html`), and interactive demo (`demo.html`)."
    )
    output.append("7. **Automated Vitest Test Suite (`tests/unit/`):**")
    output.append(
        "   - Unit test suites covering CDP capture, normalizers, poller, outbound writeback planner, passive interceptor, and sync queue."
    )
    output.append("")
    output.append("---")
    output.append("")

    # Project Directory Tree
    output.append("## 2. Project Directory Tree")
    output.append("")
    output.append("```text")
    output.append(tree_str)
    output.append("```")
    output.append("")
    output.append("---")
    output.append("")

    # Table of Contents
    output.append("## 3. Table of Contents & File Index")
    output.append("")
    output.append("| # | Relative Path | Category | Lines | Size (Bytes) | Quick Link |")
    output.append("|:--|:--------------|:---------|------:|-------------:|:-----------|")

    for idx, rec in enumerate(file_records, 1):
        anchor = f"file-{slugify(rec['path'])}"
        lines_display = f"{rec['lines']:,}" if not rec["is_bin"] else "Binary"
        cat_short = (
            rec["category"].split(". ", 1)[1] if ". " in rec["category"] else rec["category"]
        )
        output.append(
            f"| {idx} | `{rec['path']}` | {cat_short} | {lines_display} | {rec['size']:,} | [View Code](#{anchor}) |"
        )

    output.append("")
    output.append("---")
    output.append("")

    # Source Code Sections
    output.append("## 4. Full Codebase by Relative Path")
    output.append("")

    current_cat = None
    for idx, rec in enumerate(file_records, 1):
        if rec["category"] != current_cat:
            current_cat = rec["category"]
            output.append("")
            output.append(f"### {current_cat}")
            output.append("")

        anchor = f"file-{slugify(rec['path'])}"
        output.append(f'<a id="{anchor}"></a>')
        output.append(f"#### [{idx}/{total_files}] File: `{rec['path']}`")
        output.append("")
        output.append(f"- **Relative Path:** `{rec['path']}`")
        output.append(f"- **Category:** {rec['category']}")
        output.append(f"- **File Size:** {rec['size']:,} bytes")
        if not rec["is_bin"]:
            output.append(f"- **Line Count:** {rec['lines']:,} lines")
        output.append(f"- **Format:** `{rec['lang']}`")
        output.append("- [↑ Back to Table of Contents](#3-table-of-contents--file-index)")
        output.append("")

        if rec["is_bin"]:
            with open(rec["full_path"], "rb") as bfh:
                b64_data = base64.b64encode(bfh.read()).decode("ascii")
            output.append("```text")
            output.append(f"[Binary Asset: {rec['size']} bytes]")
            output.append(f"Data URI: data:image/png;base64,{b64_data}")
            output.append("```")
        else:
            with open(rec["full_path"], "r", encoding="utf-8", errors="replace") as sfh:
                content = sfh.read()
            fence = safe_fence(content)
            output.append(f"{fence}{rec['lang']}")
            output.append(content)
            output.append(fence)

        output.append("")
        output.append("---")
        output.append("")

    stats = {
        "files": total_files,
        "lines": total_lines,
        "bytes": total_bytes,
    }
    return "\n".join(output), stats


def bundle(root_dir: str, output_path: str):
    print(f"Scanning workspace root: {root_dir}")
    rendered, stats = render_bundle_markdown(root_dir)

    temp_output_path = output_path + ".tmp"
    with open(temp_output_path, "w", encoding="utf-8") as out_fh:
        out_fh.write(rendered)

    os.replace(temp_output_path, output_path)

    print(f" Successfully compiled & updated: {output_path}")
    print(f" Total files bundled: {stats['files']}")
    print(f" Total source lines: {stats['lines']:,}")
    print(
        f" Total source size: {stats['bytes']:,} bytes (~{stats['bytes'] / (1024 * 1024):.2f} MB)"
    )
    print(
        f" Output markdown size: {os.path.getsize(output_path):,} bytes (~{os.path.getsize(output_path) / (1024 * 1024):.2f} MB)"
    )


def unpack(root_dir: str, input_path: str):
    if not os.path.exists(input_path):
        print(f"Error: {input_path} does not exist!")
        sys.exit(1)

    print(f"Reading from {input_path}...")
    with open(input_path, "r", encoding="utf-8") as f:
        text = f.read()

    pattern = re.compile(
        r"- \*\*Relative Path:\*\* `([^`]+)`.*?"
        r"(?:(`{5,})[a-zA-Z0-9_-]*\n(.*?)\n\2|Data URI: data:image/[^;]+;base64,([a-zA-Z0-9+/=]+))",
        re.DOTALL,
    )

    matches = list(pattern.finditer(text))
    if not matches:
        print(f"Error: No valid file blocks matched in {input_path}")
        sys.exit(1)

    print(f"Found {len(matches)} files to unpack into {root_dir}")
    unpacked_count = 0
    total_bytes = 0

    for m in matches:
        rel_path = m.group(1).strip()
        normalized = os.path.normpath(rel_path)
        if normalized.startswith("..") or os.path.isabs(normalized):
            print(f"Skipping dangerous path: {rel_path}")
            continue

        target_file = os.path.join(root_dir, normalized)
        os.makedirs(os.path.dirname(target_file), exist_ok=True)

        if m.group(3) is not None:
            content = m.group(3)
            with open(target_file, "w", encoding="utf-8") as out_f:
                out_f.write(content)
            file_size = len(content.encode("utf-8"))
        elif m.group(4) is not None:
            b64_content = m.group(4).strip()
            binary_data = base64.b64decode(b64_content)
            with open(target_file, "wb") as out_f:
                out_f.write(binary_data)
            file_size = len(binary_data)
        else:
            continue

        unpacked_count += 1
        total_bytes += file_size

    print(f" Successfully unpacked {unpacked_count} files ({total_bytes:,} bytes).")


def strip_generated_timestamp(markdown_text: str) -> str:
    return re.sub(
        r"^> \*\*Generated Date:\*\* .*$",
        "> **Generated Date:** <TIMESTAMP>",
        markdown_text,
        flags=re.MULTILINE,
    )


def check_status(root_dir: str, output_path: str) -> int:
    if not os.path.exists(output_path):
        print(f"Status: {output_path} does not exist. Run `npm run update:codebase`.")
        return 1

    rendered, stats = render_bundle_markdown(root_dir)
    with open(output_path, "r", encoding="utf-8") as f:
        existing = f.read()

    if strip_generated_timestamp(existing) != strip_generated_timestamp(rendered):
        print(
            f"{os.path.basename(output_path)} is out of date (expected {stats['files']} files, {stats['lines']:,} lines). Run `npm run update:codebase`."
        )
        return 1

    out_bytes = os.path.getsize(output_path)
    print(
        f"{os.path.basename(output_path)} is in sync ({stats['files']} files, {stats['lines']:,} lines, ~{out_bytes / (1024 * 1024):.2f} MB)."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Bundle or unpack project codebase into PROJECT_CODEBASE.md"
    )
    parser.add_argument(
        "--unpack",
        "--extract",
        action="store_true",
        help="Unpack files from PROJECT_CODEBASE.md into workspace",
    )
    parser.add_argument(
        "--update",
        "--pack",
        "--bundle",
        action="store_true",
        help="Compile/update PROJECT_CODEBASE.md from workspace (default)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify PROJECT_CODEBASE.md matches the current workspace files",
    )
    parser.add_argument(
        "--output",
        "-o",
        default=None,
        help=f"Path to output file (default: {OUTPUT_FILENAME} in workspace root)",
    )

    args = parser.parse_args()
    workspace_root = get_workspace_root()
    target_output = (
        args.output if args.output else os.path.join(workspace_root, OUTPUT_FILENAME)
    )

    if args.check:
        return check_status(workspace_root, target_output)
    if args.unpack:
        unpack(workspace_root, target_output)
        return 0
    bundle(workspace_root, target_output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
