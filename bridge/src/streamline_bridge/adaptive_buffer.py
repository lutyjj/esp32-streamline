"""Bounded playout targets from relative arrival delay and clean streaming time."""

from __future__ import annotations

import math
from collections import deque

CLEAN_SECONDS = 60.0
STEP_SECONDS = 0.05


class AdaptiveBuffer:
    """Learn quickly, release one delay step per clean minute, retain across reconnects."""

    def __init__(self, minimum: int, maximum: int, interval: float) -> None:
        if not 1 <= minimum <= maximum:
            raise ValueError("buffer minimum must not exceed maximum")
        self.minimum = minimum
        self.maximum = maximum
        self.target = minimum
        self._interval = interval
        self._step = max(1, math.ceil(STEP_SECONDS / interval))
        self._history: deque[tuple[int, float, float]] = deque(maxlen=60)
        self._transit = 0.0
        self._last_arrival: float | None = None
        self._last_change: float | None = None
        self._last_impairment: float | None = None

    def reset_arrivals(self) -> None:
        self._history.clear()
        self._last_arrival = None
        self._last_change = None

    def observe(self, advance: int | None, now: float) -> None:
        if advance is not None and advance <= 0:
            return
        if self._last_arrival is None or advance is None:
            self.reset_arrivals()
            self._transit = 0.0
            self._last_change = now
        else:
            self._transit += now - self._last_arrival - advance * self._interval
        self._last_arrival = now
        second = int(now)
        while self._history and self._history[0][0] <= second - 60:
            self._history.popleft()
        if self._history and self._history[-1][0] == second:
            _, low, high = self._history[-1]
            self._history[-1] = (second, min(low, self._transit), max(high, self._transit))
        else:
            self._history.append((second, self._transit, self._transit))
        delay = max(high for _, _, high in self._history) - min(low for _, low, _ in self._history)
        steps = math.ceil(max(0.0, delay - 1e-9) / (self._step * self._interval))
        required = min(self.maximum, self.minimum + steps * self._step)
        if required > self.target:
            self.target = required
            self._last_change = now
        elif (
            self._last_change is not None
            and now - self._last_change >= CLEAN_SECONDS
            and (self._last_impairment is None or now - self._last_impairment >= CLEAN_SECONDS)
        ):
            self.target = max(required, self.target - self._step)
            self._last_change = now

    def impair(self, now: float) -> None:
        """Raise for bursts separated by a second; every impairment postpones decay."""
        if self._last_impairment is None or now - self._last_impairment >= 1.0:
            self.target = min(self.maximum, self.target + self._step)
        self._last_impairment = now
        self._last_change = now
