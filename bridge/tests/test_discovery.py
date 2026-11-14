from __future__ import annotations

import json
import socket
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from zeroconf import EventLoopBlocked, IPVersion, ServiceBrowser, ServiceInfo, ServiceListener, Zeroconf

import streamline_bridge.discovery as discovery
from streamline_bridge.discovery import (
    SERVICE_TYPE,
    BridgeAdvertisement,
    advertise,
    dialable_address,
    service_info,
)
from streamline_bridge.options import MAX_BRIDGE_NAME_BYTES, validate_bridge_name

LOOPBACK = "127.0.0.1"
NAME = "StreamLine Bridge"


def resolve(name: str) -> ServiceInfo | None:
    """Resolve one instance the way a device does: PTR, SRV, TXT, and A from the wire."""
    browser = Zeroconf(interfaces=[LOOPBACK], ip_version=IPVersion.V4Only)
    try:
        info = ServiceInfo(SERVICE_TYPE, name)
        return info if info.request(browser, 3000) else None
    finally:
        browser.close()


def registered(name: str = NAME) -> BridgeAdvertisement:
    """Advertise on loopback, which `advertise` itself never offers devices."""
    advertisement = BridgeAdvertisement.register(service_info(name, LOOPBACK, 39000, 8088))
    assert advertisement is not None
    return advertisement


class DiscoveryContractTests(unittest.TestCase):
    def test_advertisement_matches_the_machine_readable_discovery_contract(self) -> None:
        contract = json.loads(Path("/repo/docs/bridge-discovery.json").read_text(encoding="utf-8"))
        info = service_info(NAME, "192.0.2.20", 39000, 8088)

        self.assertEqual(SERVICE_TYPE, f"{contract['service_type']}.local.")
        self.assertEqual(list(info.decoded_properties), contract["txt_keys"])
        self.assertEqual(info.decoded_properties["txtvers"], contract["txtvers"])


class DialableAddressTests(unittest.TestCase):
    def test_a_specific_ipv4_bind_is_the_address_devices_dial(self) -> None:
        self.assertEqual(dialable_address("192.0.2.20"), "192.0.2.20")

    def test_an_unspecified_bind_offers_the_default_route_address(self) -> None:
        with patch.object(discovery, "default_route_address", return_value="192.0.2.21"):
            self.assertEqual(dialable_address("0.0.0.0"), "192.0.2.21")

    def test_binds_a_device_cannot_dial_are_not_advertised(self) -> None:
        for bind in ("127.0.0.1", "bridge.example"):
            with self.subTest(bind=bind):
                self.assertIsNone(dialable_address(bind))

    def test_a_host_without_a_route_or_sockets_is_not_advertised(self) -> None:
        with patch.object(discovery, "default_route_address", return_value=None):
            self.assertIsNone(advertise(NAME, "0.0.0.0", 39000, "0.0.0.0", 8088))
        with patch.object(socket, "socket", side_effect=OSError("too many open files")):
            self.assertIsNone(discovery.default_route_address())


class AdvertisedRecordTests(unittest.TestCase):
    def test_the_console_port_rides_along_only_where_http_listens(self) -> None:
        cases = {"0.0.0.0": "8088", "192.0.2.20": "8088", "127.0.0.1": None, "192.0.2.99": None}
        for http_bind, expected in cases.items():
            with (
                self.subTest(http_bind=http_bind),
                patch.object(BridgeAdvertisement, "register", return_value=None) as register,
            ):
                advertise(NAME, "192.0.2.20", 39000, http_bind, 8088)
                info: ServiceInfo = register.call_args.args[0]
                self.assertEqual(info.decoded_properties.get("http_port"), expected)


class AdvertisementTests(unittest.TestCase):
    def test_a_resolver_reads_the_name_ports_and_address(self) -> None:
        advertisement = registered("Living room")
        try:
            info = resolve(f"Living room.{SERVICE_TYPE}")
        finally:
            advertisement.close()

        assert info is not None
        self.assertEqual(info.port, 39000)
        self.assertEqual(info.parsed_addresses(), [LOOPBACK])
        self.assertEqual(info.decoded_properties, {"txtvers": "1", "http_port": "8088"})

    def test_closing_tells_resolvers_the_bridge_is_gone(self) -> None:
        added, removed = threading.Event(), threading.Event()

        class Listener(ServiceListener):
            def add_service(self, zc: Zeroconf, type_: str, name: str) -> None:
                added.set()

            def remove_service(self, zc: Zeroconf, type_: str, name: str) -> None:
                removed.set()

            def update_service(self, zc: Zeroconf, type_: str, name: str) -> None:
                pass

        browser = Zeroconf(interfaces=[LOOPBACK], ip_version=IPVersion.V4Only)
        try:
            ServiceBrowser(browser, SERVICE_TYPE, Listener())
            advertisement = registered()
            self.assertTrue(added.wait(5))
            advertisement.close()
            self.assertTrue(removed.wait(5))
        finally:
            browser.close()

    def test_a_network_without_multicast_leaves_the_bridge_unannounced(self) -> None:
        with (
            patch.object(discovery, "Zeroconf", side_effect=OSError("no multicast")),
            self.assertLogs(discovery.logger, "WARNING"),
        ):
            self.assertIsNone(BridgeAdvertisement.register(service_info(NAME, "192.0.2.20", 39000, 8088)))

    def test_a_blocked_loop_leaves_the_bridge_unannounced(self) -> None:
        created: list[Zeroconf] = []

        def recorded(interfaces: list[str], ip_version: IPVersion) -> Zeroconf:
            created.append(Zeroconf(interfaces=interfaces, ip_version=ip_version))
            return created[-1]

        try:
            with (
                patch.object(discovery, "Zeroconf", side_effect=recorded),
                patch.object(Zeroconf, "register_service", side_effect=EventLoopBlocked()),
                patch.object(Zeroconf, "close", side_effect=EventLoopBlocked()),
                self.assertLogs(discovery.logger, "WARNING"),
            ):
                self.assertIsNone(BridgeAdvertisement.register(service_info(NAME, LOOPBACK, 39000, 8088)))
        finally:
            for instance in created:
                instance.close()
        self.assertEqual(len(created), 1)
        self.assertTrue(created[0].done)

    def test_the_longest_name_stays_one_label_after_a_conflict_rename(self) -> None:
        renamed = validate_bridge_name("é" * (MAX_BRIDGE_NAME_BYTES // 2)) + "-99"

        registered(renamed).close()

    def test_a_failed_goodbye_does_not_escape_shutdown(self) -> None:
        advertisement = registered()
        with (
            patch.object(Zeroconf, "close", side_effect=EventLoopBlocked()),
            self.assertLogs(discovery.logger, "WARNING"),
        ):
            advertisement.close()
        advertisement.close()


if __name__ == "__main__":
    unittest.main()
