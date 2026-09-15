#!/usr/bin/env python3
"""Build library-catalog.json from Library/ and optional EC-gfxProgram CodeLibrary .sptx files."""
from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path


SKIP_TAGS = {
    "Root",
    "Namespaces",
    "Props",
    "IL",
    "OL",
    "Link",
    "r",
    "Items",
    "Cnt",
    "CodeSnippetPlaceHolder",
    "Snippet",
    "Resources",
    "ShapePropertyBag",
}


def read_main_xml(path: Path) -> str:
    with zipfile.ZipFile(path) as zf:
        raw = zf.read("Main.xml")
    if raw[:2] == b"\xff\xfe":
        return raw[2:].decode("utf-16-le", errors="replace")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw[3:].decode("utf-8", errors="replace")
    return raw.decode("utf-8", errors="replace")


def text_tags(xml: str, tag: str) -> list[str]:
    return re.findall(rf"<{tag}>([^<]+)</{tag}>", xml)


def parse_snippet(path: Path, root: Path, source: str) -> dict:
    xml = read_main_xml(path)
    rel = str(path.relative_to(root)).replace("\\", "/")
    composites = []
    for block in re.finditer(r"<SimpleCompositeBlock\b.*?</SimpleCompositeBlock>", xml, re.S):
        chunk = block.group(0)
        name_m = re.search(r"<Name>([^<]+)</Name>", chunk)
        if not name_m:
            continue
        name = name_m.group(1)
        inputs = re.findall(r'et="ExportedInputPort"[^>]*>.*?<Name>([^<]+)</Name>', chunk, re.S)
        outputs = re.findall(r'et="ExportedOutputPort"[^>]*>.*?<Name>([^<]+)</Name>', chunk, re.S)
        composites.append({"name": name, "inputs": inputs, "outputs": outputs})

    hardware = []
    for tag in (
        "BacnetHardwareOutput",
        "BacnetHardwareInput",
        "BacnetAnalogValue",
        "BacnetBinaryValue",
    ):
        for m in re.finditer(rf"<{tag}\b.*?</{tag}>", xml, re.S):
            chunk = m.group(0)
            name = (re.search(r"<Name>([^<]+)</Name>", chunk) or re.search(r"<NAME>([^<]+)</NAME>", chunk))
            if name:
                hardware.append({"tag": tag, "name": name.group(1)})

    tags = []
    for kind, block_tag in (("in", "IncomingTag"), ("out", "OutgoingTag")):
        for m in re.finditer(rf"<{block_tag}\b.*?</{block_tag}>", xml, re.S):
            tn = re.search(r"<TagName>([^<]+)</TagName>", m.group(0))
            if tn:
                tags.append({"kind": kind, "tagName": tn.group(1)})

    counts: dict[str, int] = {}
    named = []
    for m in re.finditer(r"<(\w+)\b[^>]*\bid=\"(\d+)\"[^>]*>", xml):
        tag, bid = m.group(1), m.group(2)
        if tag in SKIP_TAGS or tag.startswith("Namespace"):
            continue
        counts[tag] = counts.get(tag, 0) + 1

    primary = (
        composites[0]["name"]
        if composites
        else hardware[0]["name"]
        if hardware
        else next((t["tagName"] for t in tags if t["kind"] == "out"), path.stem)
    )
    aliases = {primary, path.stem, *[h["name"] for h in hardware]}
    if len(composites) == 1:
        aliases.add(composites[0]["name"])
    aliases.discard("")

    folder = str(path.parent.relative_to(root)).replace("\\", "/")
    if folder == ".":
        folder = ""

    parts = []
    if folder:
        parts.append(f"From {folder}")
    if composites:
        c0 = composites[0]
        parts.append(f"Logic module with {len(c0['inputs'])} input(s) and {len(c0['outputs'])} output(s)")
        if c0["inputs"]:
            parts.append(f"Inputs: {', '.join(c0['inputs'])}")
        if c0["outputs"]:
            parts.append(f"Outputs: {', '.join(c0['outputs'])}")
    elif hardware:
        hw = hardware[0]
        if "HardwareInput" in hw["tag"]:
            parts.append(f'Hardware input "{hw["name"]}" - reads a physical/controller input into the program')
        elif "HardwareOutput" in hw["tag"]:
            parts.append(f'Hardware output "{hw["name"]}" - drives a physical/controller output')
        else:
            parts.append(f"BACnet object snippet ({', '.join(h['name'] for h in hardware)})")
    if tags:
        parts.append("; ".join(f"{'reads' if t['kind']=='in' else 'defines'} {t['tagName']}" for t in tags))
    interesting = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:6]
    if interesting:
        parts.append("Contains: " + ", ".join(f"{t}×{n}" for t, n in interesting))

    return {
        "id": f"{source}:{rel}",
        "path": rel,
        "source": source,
        "folder": folder,
        "stem": path.stem,
        "title": primary,
        "aliases": sorted(aliases),
        "composites": composites,
        "hardware": hardware,
        "tags": tags,
        "inputs": composites[0]["inputs"] if composites else [],
        "outputs": composites[0]["outputs"] if composites else [],
        "blockSummary": counts,
        "namedBlocks": named[:40],
        "linkCount": len(re.findall(r"<Link[\s>]", xml)),
        "description": ". ".join(parts) or f"Library snippet {primary}",
    }


def collect(root: Path, source: str) -> list[dict]:
    if not root.exists():
        return []
    entries = []
    for path in sorted(root.rglob("*.sptx")):
        try:
            entries.append(parse_snippet(path, root, source))
        except Exception as exc:  # noqa: BLE001
            print(f"skip {path}: {exc}")
    return entries


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--library", default="Library")
    parser.add_argument("--codelib", default="EC-gfxProgram/CodeLibrary")
    parser.add_argument("-o", "--output", default="library-catalog.json")
    parser.add_argument("--include-codelib", action="store_true")
    args = parser.parse_args()

    entries = collect(Path(args.library), "Library")
    if args.include_codelib:
        entries.extend(collect(Path(args.codelib), "CodeLibrary"))

    payload = {
        "generatedFrom": [args.library] + ([args.codelib] if args.include_codelib else []),
        "count": len(entries),
        "entries": entries,
    }
    Path(args.output).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {len(entries)} snippets to {args.output}")


if __name__ == "__main__":
    main()
