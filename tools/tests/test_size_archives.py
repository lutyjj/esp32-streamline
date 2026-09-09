"""The ar parser reads members, long names, and skips index tables."""

import unittest
from pathlib import Path

from streamline_tools.size.archives import AR_MAGIC, ArchiveMember, archive_members, component_of


def _member(name: str, data: bytes) -> bytes:
    header = f"{name:<16}{'0':<12}{'0':<6}{'0':<6}{'100644':<8}{len(data):<10}`\n".encode("ascii")
    padding = b"\n" if len(data) % 2 else b""
    return header + data + padding


class ArchiveMembersTest(unittest.TestCase):
    def test_reads_members_in_order_with_their_data(self) -> None:
        archive = AR_MAGIC + _member("a.o/", b"alpha") + _member("b.o/", b"beta")
        members = archive_members(archive)
        self.assertEqual(
            members,
            [ArchiveMember("a.o", b"alpha"), ArchiveMember("b.o", b"beta")],
        )

    def test_resolves_gnu_long_names_and_skips_the_index(self) -> None:
        long_table = b"very_long_member_name.obj/\n"
        archive = (
            AR_MAGIC
            + _member("/", b"\x00\x00\x00\x00")  # symbol index: skipped
            + _member("//", long_table)
            + _member("/0", b"payload!")
        )
        members = archive_members(archive)
        self.assertEqual(members, [ArchiveMember("very_long_member_name.obj", b"payload!")])

    def test_odd_sized_members_respect_the_padding_byte(self) -> None:
        archive = AR_MAGIC + _member("odd.o/", b"12345") + _member("next.o/", b"ok")
        self.assertEqual([m.name for m in archive_members(archive)], ["odd.o", "next.o"])

    def test_bad_magic_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            archive_members(b"not an archive")

    def test_component_name_strips_the_lib_prefix_and_suffix(self) -> None:
        self.assertEqual(component_of(Path("/x/libesp_http_server.a")), "esp_http_server")


if __name__ == "__main__":
    unittest.main()
