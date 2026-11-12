"""Publish bridge sources to Music Assistant as Sendspin source clients.

The package splits publishing into one module per job: `capture_clock` maps
packet sequences onto capture time, `identity` persists each source's client
identity and pairings, `packet_feed` hands leased packets to the event loop,
`publisher` runs one source's Sendspin client, and `service` reconciles
publishers with the source registry. This module is the public surface.
"""

from streamline_bridge.sendspin.identity import SendspinIdentityStore, SendspinStateError
from streamline_bridge.sendspin.service import SendspinService

__all__ = ["SendspinIdentityStore", "SendspinService", "SendspinStateError"]
