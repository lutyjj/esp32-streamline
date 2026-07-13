"""Shared Home Assistant fixtures for StreamLine tests."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Load the repository's custom integration in every test."""
