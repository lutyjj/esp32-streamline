"""Bounded one-minute playout observations, independent of status polling."""

from __future__ import annotations

from collections import Counter, deque
from typing import Literal

QualityEvent = Literal[
    "audio_packets", "silence_packets", "missing_packets", "late_packets", "underruns", "disconnects"
]
EVENTS: tuple[QualityEvent, ...] = (
    "audio_packets",
    "silence_packets",
    "missing_packets",
    "late_packets",
    "underruns",
    "disconnects",
)
WINDOW_SECONDS = 60


class QualityWindow:
    """Count events in one-second buckets under the owning playout lock."""

    def __init__(self) -> None:
        self._started: float | None = None
        self._buckets: deque[tuple[int, Counter[QualityEvent]]] = deque(maxlen=WINDOW_SECONDS)

    def record(self, event: QualityEvent, now: float) -> None:
        if self._started is None:
            self._started = now
        second = int(now)
        self._expire(second)
        if not self._buckets or self._buckets[-1][0] != second:
            self._buckets.append((second, Counter()))
        self._buckets[-1][1][event] += 1

    def snapshot(self, now: float) -> dict[str, int | float]:
        self._expire(int(now))
        totals: Counter[QualityEvent] = Counter()
        for _, bucket in self._buckets:
            totals.update(bucket)
        return {
            "window_seconds": WINDOW_SECONDS,
            "observed_seconds": 0.0 if self._started is None else min(WINDOW_SECONDS, max(0.0, now - self._started)),
            **{event: totals[event] for event in EVENTS},
        }

    def _expire(self, second: int) -> None:
        while self._buckets and self._buckets[0][0] <= second - WINDOW_SECONDS:
            self._buckets.popleft()
