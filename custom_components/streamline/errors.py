"""Errors raised by the StreamLine bridge client."""


class StreamLineApiError(Exception):
    """The bridge rejected a request or returned an invalid response."""


class StreamLineAuthenticationError(StreamLineApiError):
    """The bridge rejected the recording token."""


class StreamLineCannotConnect(StreamLineApiError):
    """The bridge could not be reached."""
