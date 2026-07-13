"""The result model every device check produces."""

from dataclasses import dataclass


@dataclass(frozen=True)
class CheckResult:
    """Outcome of one named smoke check."""

    check: str
    passed: bool
    detail: str
