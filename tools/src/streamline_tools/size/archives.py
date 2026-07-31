"""Map defined symbols to the static archive that owns them.

ESP-IDF components are built into `lib<name>.a` archives, and the Wi-Fi/PHY
blobs ship prebuilt in the same format. A symbol found in exactly one archive
belongs to that component; the ELF walk in `report` uses this map to charge
each linked byte to its owner.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

from elftools.elf.elffile import ELFFile
from elftools.elf.sections import SymbolTableSection

AR_MAGIC = b"!<arch>\n"
_HEADER_BYTES = 60


@dataclass(frozen=True)
class ArchiveMember:
    """One object file inside a `.a` archive."""

    name: str
    data: bytes


def archive_members(archive: bytes) -> list[ArchiveMember]:
    """Parse a System V `ar` archive into its members.

    The format is a magic line followed by 60-byte headers, each naming a
    member and its size. The extended-name table (`//`) resolves the long
    names GNU ar truncates out of the fixed-width header field; the symbol
    index (`/`) is skipped because the members themselves are re-indexed.
    """
    if not archive.startswith(AR_MAGIC):
        raise ValueError("not an ar archive: bad magic")
    members: list[ArchiveMember] = []
    long_names = b""
    offset = len(AR_MAGIC)
    while offset + _HEADER_BYTES <= len(archive):
        header = archive[offset : offset + _HEADER_BYTES]
        name_field = header[0:16].decode("ascii").rstrip()
        size = int(header[48:58].decode("ascii").rstrip())
        data = archive[offset + _HEADER_BYTES : offset + _HEADER_BYTES + size]
        # Member data is 2-byte aligned; a padding byte follows odd sizes.
        offset += _HEADER_BYTES + size + (size % 2)
        if name_field == "//":
            long_names = data
            continue
        if name_field == "/":
            continue
        members.append(ArchiveMember(_member_name(name_field, long_names), data))
    return members


def _member_name(field: str, long_names: bytes) -> str:
    if field.startswith("/") and field[1:].isdigit():
        start = int(field[1:])
        end = long_names.index(b"\n", start)
        return long_names[start:end].decode("ascii").rstrip("/")
    return field.rstrip("/")


def defined_symbols(member: ArchiveMember) -> set[str]:
    """Globally defined symbol names in one ELF object."""
    try:
        elf = ELFFile(io.BytesIO(member.data))
    except Exception:
        # Archives may carry non-ELF members (linker scripts, empty stubs).
        return set()
    names: set[str] = set()
    for section in elf.iter_sections():
        if not isinstance(section, SymbolTableSection):
            continue
        for symbol in section.iter_symbols():
            if symbol["st_shndx"] == "SHN_UNDEF" or not symbol.name:
                continue
            if symbol["st_info"]["bind"] in ("STB_GLOBAL", "STB_WEAK"):
                names.add(symbol.name)
    return names


def component_of(path: Path) -> str:
    """The component name an archive path implies: `libfoo.a` owns `foo`."""
    stem = path.name.removeprefix("lib").removesuffix(".a")
    return stem


def symbol_owners(archives: dict[str, list[Path]]) -> dict[str, str]:
    """Build the symbol → owner map from labeled archive groups.

    `archives` maps a label prefix (for example `""` for built components,
    `"blob:"` for prebuilt radio libraries) to the archive paths under it.
    The first owner seen for a symbol wins, matching how the linker resolves
    a multiply-defined symbol from the earliest archive on its command line.
    """
    owners: dict[str, str] = {}
    for prefix, paths in archives.items():
        for path in paths:
            owner = prefix + component_of(path)
            for member in archive_members(path.read_bytes()):
                for name in defined_symbols(member):
                    owners.setdefault(name, owner)
    return owners
