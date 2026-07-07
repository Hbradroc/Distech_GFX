#!/usr/bin/env python3
"""
Distech EC-gfxProgram (.gfx) parameter helper.

Preferred: web app (gfx-core.js) or Node CLI bridge (gfx_cli.mjs).
This script delegates to gfx_cli.mjs when Node.js is available.

Typical workflow:
  npm install
  python gfx_param_tool.py list "project.gfx" -o parameters.csv
  python gfx_param_tool.py apply "project.gfx" parameters.csv -o "project_modified.gfx"
"""

from __future__ import annotations

import argparse
import csv
import shutil
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
import xml.etree.ElementTree as ET


SCRIPT_DIR = Path(__file__).resolve().parent
NODE_CLI = SCRIPT_DIR / "gfx_cli.mjs"


# Resource blocks whose DefaultValue field is commonly edited as a "parameter".
DEFAULT_VALUE_BLOCKS = {
    "BacnetAnalogValueResource": "AnalogValue",
    "BacnetBinaryValueResource": "BinaryValue",
    "BacnetMultiStateValueResource": "MultiStateValue",
}

# Hardware input scaling / limits.
HARDWARE_INPUT_FIELDS = (
    "SignalOffset",
    "SignalLowLimit",
    "SignalHighLimit",
    "Offset",
    "Minimum",
    "Maximum",
    "Default",
)

REGISTER_FIELDS = ("defaultValue", "unit")


@dataclass
class Parameter:
    category: str
    name: str
    field: str
    value: str
    index: str = ""
    controller_specific: str = ""
    source: str = "Main.xml"

    @property
    def key(self) -> tuple[str, str, str, str]:
        return (self.source, self.category, self.name, self.field)


def extract_gfx(gfx_path: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(gfx_path, "r") as zf:
        zf.extractall(dest)


def pack_gfx(source_dir: Path, gfx_path: Path) -> None:
    gfx_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(gfx_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(source_dir.rglob("*")):
            if file_path.is_file():
                arcname = file_path.relative_to(source_dir).as_posix()
                zf.write(file_path, arcname)


def _text(elem: ET.Element | None, default: str = "") -> str:
    if elem is None or elem.text is None:
        return default
    return elem.text.strip()


def iter_main_xml_parameters(main_xml: Path) -> Iterable[Parameter]:
    tree = ET.parse(main_xml)
    root = tree.getroot()

    for block in root:
        tag = block.tag
        if tag in DEFAULT_VALUE_BLOCKS:
            yield Parameter(
                category=DEFAULT_VALUE_BLOCKS[tag],
                name=_text(block.find("NAME")),
                field="DefaultValue",
                value=_text(block.find("DefaultValue")),
                index=_text(block.find("IDX")),
                controller_specific=_text(block.find("ControllerSpecific")),
            )
        elif tag == "BacnetHardwareInputResource":
            name = _text(block.find("NAME"))
            for field in HARDWARE_INPUT_FIELDS:
                value = _text(block.find(field))
                if value:
                    yield Parameter(
                        category="HardwareInput",
                        name=name,
                        field=field,
                        value=value,
                        index=_text(block.find("IDX")),
                    )
        elif tag == "InternalConstantNumeric":
            props = block.find("Props")
            value_elem = props.find("Value") if props is not None else None
            if value_elem is not None and _text(value_elem):
                yield Parameter(
                    category="InternalConstant",
                    name=_text(block.find("Name"), "Internal Constant"),
                    field="Value",
                    value=_text(value_elem),
                )

    com_config = main_xml.parent / "Config" / "Bacnet" / "ComSensors" / "CommonConfig.xml"
    if com_config.exists():
        yield from iter_com_sensor_parameters(com_config)


def iter_com_sensor_parameters(com_config: Path) -> Iterable[Parameter]:
    tree = ET.parse(com_config)
    root = tree.getroot()
    for register in root.iter("Register"):
        name = register.attrib.get("name", "")
        for field in REGISTER_FIELDS:
            if field in register.attrib:
                yield Parameter(
                    category="ComSensorRegister",
                    name=name,
                    field=field,
                    value=register.attrib[field],
                    source="Config/Bacnet/ComSensors/CommonConfig.xml",
                )


def list_parameters(gfx_path: Path) -> list[Parameter]:
    with tempfile.TemporaryDirectory(prefix="gfx_extract_") as tmp:
        work = Path(tmp)
        extract_gfx(gfx_path, work)
        main_xml = work / "Main.xml"
        if not main_xml.exists():
            raise FileNotFoundError("Main.xml not found inside .gfx archive")
        return sorted(iter_main_xml_parameters(main_xml), key=lambda p: (p.category, p.name, p.field))


def write_csv(parameters: list[Parameter], csv_path: Path) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "source",
                "category",
                "name",
                "field",
                "value",
                "index",
                "controller_specific",
            ],
        )
        writer.writeheader()
        for param in parameters:
            writer.writerow(
                {
                    "source": param.source,
                    "category": param.category,
                    "name": param.name,
                    "field": param.field,
                    "value": param.value,
                    "index": param.index,
                    "controller_specific": param.controller_specific,
                }
            )


def read_csv(csv_path: Path) -> dict[tuple[str, str, str, str], str]:
    updates: dict[tuple[str, str, str, str], str] = {}
    with csv_path.open("r", newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        required = {"source", "category", "name", "field", "value"}
        if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
            raise ValueError(
                "CSV must include columns: source, category, name, field, value"
            )
        for row in reader:
            key = (
                row["source"].strip(),
                row["category"].strip(),
                row["name"].strip(),
                row["field"].strip(),
            )
            updates[key] = row["value"].strip()
    return updates


def apply_updates_to_main_xml(main_xml: Path, updates: dict[tuple[str, str, str, str], str]) -> list[str]:
    tree = ET.parse(main_xml)
    root = tree.getroot()
    changed: list[str] = []

    for block in root:
        tag = block.tag
        if tag in DEFAULT_VALUE_BLOCKS:
            category = DEFAULT_VALUE_BLOCKS[tag]
            name = _text(block.find("NAME"))
            key = ("Main.xml", category, name, "DefaultValue")
            if key in updates:
                elem = block.find("DefaultValue")
                if elem is None:
                    elem = ET.SubElement(block, "DefaultValue")
                old = _text(elem)
                new = updates[key]
                if old != new:
                    elem.text = new
                    changed.append(f"{category}.{name}.DefaultValue: {old} -> {new}")
        elif tag == "BacnetHardwareInputResource":
            name = _text(block.find("NAME"))
            for field in HARDWARE_INPUT_FIELDS:
                key = ("Main.xml", "HardwareInput", name, field)
                if key not in updates:
                    continue
                elem = block.find(field)
                if elem is None:
                    elem = ET.SubElement(block, field)
                old = _text(elem)
                new = updates[key]
                if old != new:
                    elem.text = new
                    changed.append(f"HardwareInput.{name}.{field}: {old} -> {new}")
        elif tag == "InternalConstantNumeric":
            name = _text(block.find("Name"), "Internal Constant")
            key = ("Main.xml", "InternalConstant", name, "Value")
            if key in updates:
                props = block.find("Props")
                if props is None:
                    props = ET.SubElement(block, "Props")
                elem = props.find("Value")
                if elem is None:
                    elem = ET.SubElement(props, "Value")
                old = _text(elem)
                new = updates[key]
                if old != new:
                    elem.text = new
                    changed.append(f"InternalConstant.{name}.Value: {old} -> {new}")

    com_config = main_xml.parent / "Config" / "Bacnet" / "ComSensors" / "CommonConfig.xml"
    if com_config.exists():
        changed.extend(apply_updates_to_com_config(com_config, updates))

    tree.write(main_xml, encoding="utf-8", xml_declaration=True)
    return changed


def apply_updates_to_com_config(com_config: Path, updates: dict[tuple[str, str, str, str], str]) -> list[str]:
    tree = ET.parse(com_config)
    root = tree.getroot()
    changed: list[str] = []
    source = "Config/Bacnet/ComSensors/CommonConfig.xml"

    for register in root.iter("Register"):
        name = register.attrib.get("name", "")
        for field in REGISTER_FIELDS:
            key = (source, "ComSensorRegister", name, field)
            if key not in updates:
                continue
            old = register.attrib.get(field, "")
            new = updates[key]
            if old != new:
                register.attrib[field] = new
                changed.append(f"ComSensorRegister.{name}.{field}: {old} -> {new}")

    tree.write(com_config, encoding="utf-8", xml_declaration=True)
    return changed


def apply_parameters(gfx_path: Path, csv_path: Path, output_path: Path) -> list[str]:
    updates = read_csv(csv_path)
    if not updates:
        raise ValueError("No parameter updates found in CSV")

    with tempfile.TemporaryDirectory(prefix="gfx_apply_") as tmp:
        work = Path(tmp)
        extract_gfx(gfx_path, work)
        main_xml = work / "Main.xml"
        if not main_xml.exists():
            raise FileNotFoundError("Main.xml not found inside .gfx archive")
        changed = apply_updates_to_main_xml(main_xml, updates)
        pack_gfx(work, output_path)
    return changed


def node_cli_available() -> bool:
    if not NODE_CLI.exists():
        return False
    try:
        subprocess.run(
            ["node", "--version"],
            capture_output=True,
            check=True,
            timeout=10,
        )
        return True
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
        return False


def run_node_cli(argv: list[str]) -> int:
    return subprocess.call(["node", str(NODE_CLI), *argv])


def cmd_list(args: argparse.Namespace) -> int:
    if node_cli_available():
        cli_args = ["list", str(args.gfx)]
        if args.output:
            cli_args.extend(["-o", str(args.output)])
        return run_node_cli(cli_args)

    print(
        "Note: Node.js not found — using legacy Python parser (subset of parameters). "
        "Install Node.js and run 'npm install' for full parity with the web app.",
        file=sys.stderr,
    )
    params = list_parameters(Path(args.gfx))
    if args.output:
        write_csv(params, Path(args.output))
        print(f"Wrote {len(params)} parameters to {args.output}")
    else:
        for param in params:
            print(
                f"{param.category:16} {param.name:24} {param.field:16} = {param.value}"
            )
        print(f"\nTotal: {len(params)} parameters")
    return 0


def cmd_apply(args: argparse.Namespace) -> int:
    gfx = Path(args.gfx)
    csv_path = Path(args.csv)
    output = Path(args.output) if args.output else gfx.with_name(gfx.stem + "_modified.gfx")

    if output.resolve() == gfx.resolve() and not args.force:
        raise SystemExit(
            "Refusing to overwrite the input .gfx file. Use -o to choose an output file."
        )

    if args.backup:
        backup = gfx.with_suffix(gfx.suffix + ".bak")
        shutil.copy2(gfx, backup)
        print(f"Backup saved to {backup}")

    if node_cli_available():
        return run_node_cli(["apply", str(gfx), str(csv_path), "-o", str(output)])

    print(
        "Note: Node.js not found — using legacy Python parser (subset of parameters). "
        "Install Node.js and run 'npm install' for full parity with the web app.",
        file=sys.stderr,
    )
    changed = apply_parameters(gfx, csv_path, output)
    if changed:
        print(f"Updated {len(changed)} value(s):")
        for line in changed:
            print(f"  - {line}")
    else:
        print("No values changed (CSV values match the current .gfx file).")
    print(f"Wrote {output}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="List or edit Distech EC-gfxProgram (.gfx) parameters."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    list_parser = sub.add_parser("list", help="List parameters or export to CSV")
    list_parser.add_argument("gfx", help="Path to .gfx file")
    list_parser.add_argument("-o", "--output", help="Write parameters to CSV")
    list_parser.set_defaults(func=cmd_list)

    apply_parser = sub.add_parser("apply", help="Apply CSV parameter changes to a .gfx file")
    apply_parser.add_argument("gfx", help="Source .gfx file")
    apply_parser.add_argument("csv", help="CSV file with updated values")
    apply_parser.add_argument("-o", "--output", help="Output .gfx path")
    apply_parser.add_argument(
        "--backup", action="store_true", help="Save a .gfx.bak copy before applying"
    )
    apply_parser.add_argument(
        "--force",
        action="store_true",
        help="Allow overwriting the source .gfx when -o is omitted",
    )
    apply_parser.set_defaults(func=cmd_apply)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001 - CLI tool should show a clean error
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
