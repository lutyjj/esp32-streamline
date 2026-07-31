"""Crate attribution reads the crate root out of both Rust manglings."""

import unittest

from streamline_tools.size.symbols import rust_crate


class RustCrateTest(unittest.TestCase):
    def test_v0_plain_crate_root(self) -> None:
        self.assertEqual(rust_crate("_RNvCscqUcgabWelp_19streamline_firmware4main"), "streamline_firmware")

    def test_v0_crate_behind_generic_and_impl_prefixes(self) -> None:
        # Path prefixes carry their own `s<base62>_` disambiguators with
        # digits, so the crate production must be found, not anchored.
        name = "_RINvXs5_NtCs3UtSbZXleNY_10serde_json2deQINtB6_12DeserializerE"
        self.assertEqual(rust_crate(name), "serde_json")

    def test_v0_without_crate_disambiguator(self) -> None:
        self.assertEqual(rust_crate("_RNvC4core3fmt"), "core")

    def test_legacy_first_segment_is_the_crate(self) -> None:
        self.assertEqual(rust_crate("_ZN4core3fmt9Formatter3pad17h1234567890abcdefE"), "core")

    def test_legacy_impl_segment_is_not_an_identifier(self) -> None:
        # `<T as Trait>` impl symbols open with a `_$LT$` segment; that is
        # not a crate name and must not be reported as one.
        self.assertIsNone(rust_crate("_ZN63_$LT$alloc..vec..Vec$LT$T$GT$$u20$as$u20$core..fmt..Debug$GT$3fmt17habcE"))

    def test_c_symbols_are_not_rust(self) -> None:
        self.assertIsNone(rust_crate("mbedtls_ssl_handshake_client_step"))
        self.assertIsNone(rust_crate("_vfprintf_r"))

    def test_length_running_past_the_symbol_is_rejected(self) -> None:
        self.assertIsNone(rust_crate("_RNvC99short"))


if __name__ == "__main__":
    unittest.main()
