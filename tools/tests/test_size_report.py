"""Attribution charges archive owners first, then crates, and keeps a rest."""

import unittest

from streamline_tools.size.report import attribute, render
from streamline_tools.size.symbols import FlashSymbol


def _symbol(name: str, size: int) -> FlashSymbol:
    return FlashSymbol(name, ".flash.text", size)


class AttributeTest(unittest.TestCase):
    def test_archive_ownership_wins_over_crate_parsing(self) -> None:
        symbols = [_symbol("_RNvC4esp_5thing", 10)]
        attribution = attribute(symbols, {"_RNvC4esp_5thing": "esp_system"})
        self.assertEqual(attribution.owners, {"esp_system": 10})

    def test_rust_symbols_group_by_crate(self) -> None:
        symbols = [
            _symbol("_RNvCscqUcgabWelp_19streamline_firmware4main", 7),
            _symbol("_RNvCscqUcgabWelp_19streamline_firmware4tick", 5),
            _symbol("mbedtls_thing", 3),
        ]
        attribution = attribute(symbols, {"mbedtls_thing": "mbedtls"})
        self.assertEqual(
            attribution.owners,
            {"crate:streamline_firmware": 12, "mbedtls": 3},
        )

    def test_unparsed_mangled_names_stay_visible_as_rust(self) -> None:
        attribution = attribute([_symbol("_ZN63_$LT$weird$GT$3fmt17hE", 4)], {})
        self.assertEqual(attribution.owners, {"crate:rust (unparsed)": 4})

    def test_unknown_c_symbols_are_unattributed_and_counted_in_total(self) -> None:
        attribution = attribute([_symbol("mystery", 9)], {})
        self.assertEqual(attribution.owners, {})
        self.assertEqual([entry.name for entry in attribution.unattributed], ["mystery"])
        self.assertEqual(attribution.total, 9)


class RenderTest(unittest.TestCase):
    def test_owners_sort_largest_first_and_the_total_closes_the_table(self) -> None:
        symbols = [_symbol("a", 1), _symbol("_RNvC3big5thing", 100)]
        attribution = attribute(symbols, {})
        text = render(attribution, symbols, top=1)
        lines = text.splitlines()
        self.assertIn("      100  crate:big", lines)
        self.assertIn("        1  (unattributed symbols)", lines)
        self.assertIn("      101  total attributed flash bytes", lines)
        self.assertIn("      100  .flash.text           _RNvC3big5thing", lines)


if __name__ == "__main__":
    unittest.main()
