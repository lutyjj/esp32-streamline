"""Read the linked ELF's flash symbols and name each Rust symbol's crate.

The loader stays a thin pyelftools walk; the classification logic — which
sections count against the OTA slot, and which crate a mangled name belongs
to — is pure and unit-tested.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from elftools.elf.elffile import ELFFile
from elftools.elf.sections import SymbolTableSection

# Sections whose bytes the OTA image stores. RAM-only sections (`.dram0.bss`,
# heap) and debug sections cost no flash and stay out of the report.
FLASH_SECTIONS = frozenset(
    {
        ".flash.text",
        ".flash.rodata",
        ".flash.rodata_noload",
        ".flash.appdesc",
        ".iram0.vectors",
        ".iram0.text",
        ".dram0.data",
    }
)


@dataclass(frozen=True)
class FlashSymbol:
    """One named range of flash bytes in the linked image."""

    name: str
    section: str
    size: int


def flash_symbols(elf_path: Path) -> list[FlashSymbol]:
    """Sized symbols in flash-resident sections of the linked ELF."""
    with elf_path.open("rb") as stream:
        elf = ELFFile(stream)
        ranges = [
            (section["sh_addr"], section["sh_addr"] + section["sh_size"], section.name)
            for section in elf.iter_sections()
            if section.name in FLASH_SECTIONS and section["sh_size"] > 0
        ]
        symbols: list[FlashSymbol] = []
        for section in elf.iter_sections():
            if not isinstance(section, SymbolTableSection):
                continue
            for symbol in section.iter_symbols():
                size = symbol["st_size"]
                if size == 0 or not symbol.name:
                    continue
                address = symbol["st_value"]
                home = next((name for lo, hi, name in ranges if lo <= address < hi), None)
                if home is not None:
                    symbols.append(FlashSymbol(symbol.name, home, size))
        return symbols


# Rust v0 mangling opens with `_R`; the crate root is the `C` production —
# `C`, an optional `s<base62>_` disambiguator, then `<len><name>`. Path
# prefixes before it (`N<ns>`, `I`, `X`, their own disambiguators) vary, but
# the crate root is the innermost path element, so the first `C` production
# in the string is the crate. The name slice is validated as an identifier
# so a stray `C` inside a later identifier cannot fake a match.
_V0_CRATE = re.compile(r"C(?:s[0-9a-zA-Z]+_)?(?P<len>[1-9][0-9]*)")
# Legacy mangling is `_ZN<len><segment>...E`; the crate is the first segment.
_LEGACY_CRATE = re.compile(r"_ZN(?P<len>[1-9][0-9]*)")
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


def rust_crate(symbol_name: str) -> str | None:
    """The crate a mangled Rust symbol belongs to, or None for C symbols.

    Attribution needs only the crate root, so this parses the mangling just
    far enough to read it instead of pulling in a full demangler.
    """
    if symbol_name.startswith("_R"):
        match = _V0_CRATE.search(symbol_name, 2)
    elif symbol_name.startswith("_ZN"):
        match = _LEGACY_CRATE.match(symbol_name)
    else:
        return None
    if match is None:
        return None
    length = int(match.group("len"))
    start = match.end()
    name = symbol_name[start : start + length]
    if len(name) == length and _IDENTIFIER.match(name):
        return name
    return None
