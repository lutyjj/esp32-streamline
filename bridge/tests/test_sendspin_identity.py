from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from aiosendspin.noise.keys import generate_psk, psk_id_for
from aiosendspin.noise.trust_store import PairingPsk

from streamline_bridge.sendspin.identity import IDENTITY_FILE, PAIRING_FILE, SendspinIdentityStore, SendspinStateError


class SendspinIdentityStoreTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name)

    def tearDown(self) -> None:
        self._directory.cleanup()

    def test_each_source_keeps_its_own_identity_across_store_instances(self) -> None:
        first = SendspinIdentityStore(self.root)
        address = first.identity("192.0.2.10").peer_id
        key = first.identity("eli1-" + "0" * 32).peer_id

        reopened = SendspinIdentityStore(self.root)

        self.assertEqual(reopened.identity("192.0.2.10").peer_id, address)
        self.assertEqual(reopened.identity("eli1-" + "0" * 32).peer_id, key)
        self.assertNotEqual(address, key)
        self.assertEqual((self.root / "192.0.2.10" / IDENTITY_FILE).stat().st_mode & 0o777, 0o600)

    def test_rejects_identity_files_it_must_not_trust(self) -> None:
        store = SendspinIdentityStore(self.root)
        path = self.root / "192.0.2.10" / IDENTITY_FILE
        store.identity("192.0.2.10")

        os.chmod(path, 0o644)
        with self.assertRaisesRegex(SendspinStateError, "permissions must be 0600"):
            store.identity("192.0.2.10")
        path.write_bytes(b"short")
        os.chmod(path, 0o600)
        with self.assertRaisesRegex(SendspinStateError, "X25519"):
            store.identity("192.0.2.10")

    def test_rejects_a_source_that_is_not_a_canonical_identity(self) -> None:
        with self.assertRaises(ValueError):
            SendspinIdentityStore(self.root).identity("../escape")

    async def test_pairing_store_persists_the_pairing_secret(self) -> None:
        psk = generate_psk()
        store = await SendspinIdentityStore(self.root).pairing_store("192.0.2.10")
        await store.set_pairing_psk(PairingPsk(psk_id=psk_id_for(psk), psk=psk))

        reopened = await SendspinIdentityStore(self.root).pairing_store("192.0.2.10")

        stored = await reopened.pairing_psk()
        self.assertIsNotNone(stored)
        assert stored is not None
        self.assertEqual(stored.psk, psk)

    async def test_rejects_a_corrupt_pairing_store(self) -> None:
        path = self.root / "192.0.2.10" / PAIRING_FILE
        path.parent.mkdir(parents=True)
        path.write_text("[]")

        with self.assertRaises(SendspinStateError):
            await SendspinIdentityStore(self.root).pairing_store("192.0.2.10")


if __name__ == "__main__":
    unittest.main()
