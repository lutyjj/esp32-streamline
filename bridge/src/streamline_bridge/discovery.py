"""Advertise the PCM listener over DNS-SD so devices can offer this bridge during setup."""

from __future__ import annotations

import ipaddress
import logging
import socket

from zeroconf import Error as ZeroconfError
from zeroconf import IPVersion, ServiceInfo, Zeroconf

logger = logging.getLogger(__name__)

SERVICE_TYPE = "_streamline._tcp.local."
TXT_VERSION = "1"
# Any routed address works: connecting a UDP socket only selects a route.
_ROUTE_PROBE = ("192.0.2.1", 9)


def default_route_address() -> str | None:
    """Return this host's IPv4 address on its default route, if it has one."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(_ROUTE_PROBE)
            address: str = probe.getsockname()[0]
    except OSError:
        return None
    return address


def dialable_address(bind: str) -> str | None:
    """Return the IPv4 address a device should dial for a listener bound to ``bind``.

    An unspecified bind serves every interface, so the default route's address
    stands for the LAN. A loopback or hostname bind offers devices nothing.
    """
    try:
        address = ipaddress.IPv4Address(bind)
    except ValueError:
        return None
    if address.is_unspecified:
        return default_route_address()
    return None if address.is_loopback else str(address)


def service_info(name: str, address: str, pcm_port: int, http_port: int | None) -> ServiceInfo:
    """Describe the listener as docs/bridge-discovery.json defines it."""
    properties = {"txtvers": TXT_VERSION}
    if http_port is not None:
        properties["http_port"] = str(http_port)
    return ServiceInfo(
        SERVICE_TYPE,
        f"{name}.{SERVICE_TYPE}",
        port=pcm_port,
        properties=properties,
        # One label per address keeps two bridges' host records apart.
        server=f"streamline-bridge-{address.replace('.', '-')}.local.",
        parsed_addresses=[address],
    )


class BridgeAdvertisement:
    """One registered advertisement; closing it sends DNS-SD goodbyes."""

    def __init__(self, zeroconf: Zeroconf, info: ServiceInfo) -> None:
        self._zeroconf = zeroconf
        self.info = info

    @classmethod
    def register(cls, info: ServiceInfo) -> BridgeAdvertisement | None:
        """Announce ``info`` on its address's interface, renaming on a name conflict.

        A network that refuses multicast leaves the bridge serving unannounced.
        """
        address = info.parsed_addresses()[0]
        try:
            zeroconf = Zeroconf(interfaces=[address], ip_version=IPVersion.V4Only)
        except OSError as exc:
            logger.warning("not advertising over mDNS on %s: %s", address, exc)
            return None
        try:
            zeroconf.register_service(info, allow_name_change=True)
        except (OSError, ZeroconfError) as exc:
            _close(zeroconf)
            logger.warning("not advertising over mDNS on %s: %s", address, exc)
            return None
        logger.info("advertising %r over mDNS at %s:%s", info.name, address, info.port)
        return cls(zeroconf, info)

    def close(self) -> None:
        _close(self._zeroconf)


def _close(zeroconf: Zeroconf) -> None:
    """Send goodbyes and close; a failure never blocks startup or shutdown."""
    try:
        zeroconf.close()
    except (OSError, ZeroconfError) as exc:
        logger.warning("mDNS goodbye failed: %s", exc)


def advertise(name: str, tcp_bind: str, tcp_port: int, http_bind: str, http_port: int) -> BridgeAdvertisement | None:
    """Advertise the PCM listener, when it has an address devices can dial.

    The console port rides along only when HTTP listens on that address too.
    """
    address = dialable_address(tcp_bind)
    if address is None:
        logger.info("not advertising over mDNS: no LAN IPv4 address for PCM bind %s", tcp_bind)
        return None
    http_reachable = http_bind in ("0.0.0.0", address)
    return BridgeAdvertisement.register(service_info(name, address, tcp_port, http_port if http_reachable else None))
