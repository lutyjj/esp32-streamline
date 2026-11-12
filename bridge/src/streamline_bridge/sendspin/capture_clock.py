"""Map StreamLine packet sequence numbers onto a receiver capture timeline."""

from __future__ import annotations

from streamline_bridge.protocol import DEFAULT_FORMAT, PcmFormat

SEQUENCE_MODULUS = 1 << 32
MAX_SEQUENCE_STEP_SECONDS = 2.0
# Tracks a device clock up to this much slower than the receiver clock.
DRIFT_ALLOWANCE_PPM = 200


class CaptureClock:
    """Timestamp each packet at its capture time instead of its arrival time.

    A packet's capture time is its nominal sequence time plus the smallest
    arrival offset seen so far, so a burst released by a network stall keeps
    its original spacing. The offset estimate rises by at most
    ``DRIFT_ALLOWANCE_PPM`` of elapsed audio time, which follows a slow device
    clock without letting delayed packets pull the timeline late.
    """

    def __init__(self, pcm_format: PcmFormat = DEFAULT_FORMAT) -> None:
        self._rate = pcm_format.rate
        self._frames_per_packet = pcm_format.frames_per_packet
        self._max_step = round(MAX_SEQUENCE_STEP_SECONDS * self._rate / self._frames_per_packet)
        self._last_sequence: int | None = None
        self._packet_index = 0
        self._last_nominal_us = 0
        self._offset_us = 0

    def timestamp(self, sequence: int, arrival_us: int) -> int:
        """Return the capture time of ``sequence``, which arrived at ``arrival_us``."""
        if self._last_sequence is not None:
            step = (sequence - self._last_sequence + SEQUENCE_MODULUS // 2) % SEQUENCE_MODULUS - SEQUENCE_MODULUS // 2
            if abs(step) <= self._max_step:
                return self._advance(sequence, step, arrival_us)
        self._last_sequence = sequence
        self._packet_index = 0
        self._last_nominal_us = 0
        self._offset_us = arrival_us
        return arrival_us

    def _advance(self, sequence: int, step: int, arrival_us: int) -> int:
        index = self._packet_index + step
        nominal_us = index * self._frames_per_packet * 1_000_000 // self._rate
        if step > 0:
            elapsed_us = nominal_us - self._last_nominal_us
            self._offset_us += elapsed_us * DRIFT_ALLOWANCE_PPM // 1_000_000
            self._last_sequence = sequence
            self._packet_index = index
            self._last_nominal_us = nominal_us
        self._offset_us = min(self._offset_us, arrival_us - nominal_us)
        return nominal_us + self._offset_us
