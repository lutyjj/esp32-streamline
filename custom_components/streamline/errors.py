"""Errors shared by StreamLine bridge models and transport."""


class StreamLineApiError(Exception):
    """Base error for a bridge request or response."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class StreamLineCannotConnect(StreamLineApiError):
    """The bridge could not be reached."""


class StreamLineAuthenticationError(StreamLineApiError):
    """The bridge rejected the recording token."""
