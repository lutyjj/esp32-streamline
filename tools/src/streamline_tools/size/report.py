"""Aggregate flash bytes by owner and print the size report.

`main` locates the build products under the firmware source tree, charges
every sized flash symbol to an ESP-IDF component, a prebuilt blob, or a Rust
crate, and prints owners largest-first so a diff's flash cost has a name.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from streamline_tools.size.archives import symbol_owners
from streamline_tools.size.symbols import FlashSymbol, flash_symbols, rust_crate

BLOB_PREFIX = "blob:"


@dataclass(frozen=True)
class Attribution:
    """Flash bytes charged to their owners, plus the symbols nobody claimed."""

    owners: dict[str, int]
    unattributed: list[FlashSymbol]

    @property
    def total(self) -> int:
        return sum(self.owners.values()) + sum(symbol.size for symbol in self.unattributed)


def attribute(symbols: list[FlashSymbol], owners: dict[str, str]) -> Attribution:
    """Charge each symbol to its archive owner, else its Rust crate.

    Archive ownership wins over crate parsing: a Rust-named symbol defined by
    a component archive belongs to that component. Mangled symbols whose
    crate cannot be read are grouped under `rust (unparsed)` rather than
    silently joining the anonymous remainder.
    """
    totals: Counter[str] = Counter()
    unattributed: list[FlashSymbol] = []
    for symbol in symbols:
        owner = owners.get(symbol.name)
        if owner is None:
            crate = rust_crate(symbol.name)
            if crate is not None:
                owner = "crate:" + crate
            elif symbol.name.startswith(("_R", "_ZN")):
                owner = "crate:rust (unparsed)"
        if owner is None:
            unattributed.append(symbol)
        else:
            totals[owner] += symbol.size
    return Attribution(dict(totals), unattributed)


def discover_archives(firmware_dir: Path) -> dict[str, list[Path]]:
    """Component archives from the ESP-IDF build, blobs from the IDF tree."""
    built = sorted(firmware_dir.glob("target/*/release/build/esp-idf-sys-*/out/build/**/lib*.a"))
    blobs = sorted(firmware_dir.glob(".embuild/espressif/esp-idf/*/components/*/lib/esp32/lib*.a"))
    if not built:
        raise FileNotFoundError(f"no component archives under {firmware_dir}; run: make -C firmware build")
    return {"": built, BLOB_PREFIX: blobs}


def discover_elf(firmware_dir: Path) -> Path:
    candidates = sorted(firmware_dir.glob("target/*/release/streamline-firmware"))
    if not candidates:
        raise FileNotFoundError(f"no linked ELF under {firmware_dir}; run: make -C firmware build")
    return candidates[0]


def render(attribution: Attribution, symbols: list[FlashSymbol], top: int) -> str:
    lines = [f"{'bytes':>9}  owner"]
    for owner, size in sorted(attribution.owners.items(), key=lambda item: (-item[1], item[0])):
        lines.append(f"{size:>9}  {owner}")
    anonymous = sum(symbol.size for symbol in attribution.unattributed)
    lines.append(f"{anonymous:>9}  (unattributed symbols)")
    lines.append(f"{attribution.total:>9}  total attributed flash bytes")
    lines.append("")
    lines.append(f"largest {top} symbols:")
    for symbol in sorted(symbols, key=lambda entry: -entry.size)[:top]:
        lines.append(f"{symbol.size:>9}  {symbol.section:<20}  {symbol.name[:80]}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Attribute firmware flash bytes to components and crates")
    parser.add_argument(
        "--firmware-dir",
        type=Path,
        default=Path("/repo/firmware/streamline"),
        help="firmware source tree holding target/ and .embuild/",
    )
    parser.add_argument("--top", type=int, default=20, help="unattributed symbols to list")
    arguments = parser.parse_args()
    elf = discover_elf(arguments.firmware_dir)
    owners = symbol_owners(discover_archives(arguments.firmware_dir))
    symbols = flash_symbols(elf)
    attribution = attribute(symbols, owners)
    print(f"{elf}")
    print(render(attribution, symbols, arguments.top))
    return 0


if __name__ == "__main__":
    sys.exit(main())
