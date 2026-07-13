"""Level and spectral statistics for one aligned window."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import cast

import numpy as np

from .signal import SAMPLE_RATE, FloatArray, center

CLIP_THRESHOLD = 0.999
FREQ_BANDS: tuple[tuple[float, float], ...] = (
    (20, 60),
    (60, 120),
    (120, 250),
    (250, 1000),
    (1000, 5000),
    (5000, 15000),
)
FREQ_REFERENCE_BAND = (250.0, 1000.0)


@dataclass
class ChannelStats:
    """Per-channel level summary of one aligned window."""

    peak_dbfs: tuple[float, float]
    rms_dbfs: tuple[float, float]
    dc_offset: tuple[float, float]
    clips: int


@dataclass
class MidSideBalance:
    """Mid energy and the side-minus-mid ratio of one aligned window."""

    mid_rms_dbfs: float
    side_minus_mid_db: float


@dataclass
class BandDelta:
    """Capture-minus-reference level for one frequency band, mid-normalized."""

    lo: float
    hi: float
    capture_minus_reference_db: float


def rms_db(signal: FloatArray) -> float:
    rms = math.sqrt(max(float(np.mean(signal * signal)), 1e-20))
    return 20.0 * math.log10(rms)


def peak_db(signal: FloatArray) -> float:
    peak = max(float(np.max(np.abs(signal))), 1e-20)
    return 20.0 * math.log10(peak)


def mono_bands(audio: FloatArray, nfft: int = 8192) -> tuple[FloatArray, FloatArray]:
    mono = np.mean(center(audio), axis=1)
    hop = nfft // 2
    if mono.size < nfft:
        raise SystemExit("audio is too short for frequency analysis")
    window = np.hanning(nfft).astype(np.float32)
    spectra: list[FloatArray] = []
    for start in range(0, mono.size - nfft + 1, hop):
        block = mono[start : start + nfft] * window
        spectra.append(cast(FloatArray, np.abs(np.fft.rfft(block)) ** 2))
    psd = np.mean(np.vstack(spectra), axis=0)
    freqs = np.fft.rfftfreq(nfft, 1.0 / SAMPLE_RATE)
    return freqs, psd


def band_level(freqs: FloatArray, psd: FloatArray, lo: float, hi: float) -> float:
    mask = (freqs >= lo) & (freqs < hi)
    if not np.any(mask):
        return float("nan")
    return 10.0 * math.log10(max(float(np.mean(psd[mask])), 1e-30))


def basic_stats(audio: FloatArray) -> ChannelStats:
    """Summarize per-channel peak, RMS, DC offset, and full-scale clip count."""
    dc = np.mean(audio, axis=0)
    clips = int(np.sum(np.abs(audio) >= CLIP_THRESHOLD))
    return ChannelStats(
        peak_dbfs=(peak_db(audio[:, 0]), peak_db(audio[:, 1])),
        rms_dbfs=(rms_db(audio[:, 0]), rms_db(audio[:, 1])),
        dc_offset=(float(dc[0]), float(dc[1])),
        clips=clips,
    )


def mid_side(audio: FloatArray) -> MidSideBalance:
    """Measure mid RMS and how far side energy sits below it."""
    mid = (audio[:, 0] + audio[:, 1]) * 0.5
    side = (audio[:, 0] - audio[:, 1]) * 0.5
    return MidSideBalance(mid_rms_dbfs=rms_db(mid), side_minus_mid_db=rms_db(side) - rms_db(mid))


def frequency_delta(reference: FloatArray, capture: FloatArray) -> list[BandDelta]:
    """Per-band capture-minus-reference level, each side normalized to its mid band."""
    ref_f, ref_psd = mono_bands(reference)
    cap_f, cap_psd = mono_bands(capture)
    ref_mid = band_level(ref_f, ref_psd, *FREQ_REFERENCE_BAND)
    cap_mid = band_level(cap_f, cap_psd, *FREQ_REFERENCE_BAND)
    deltas = []
    for lo, hi in FREQ_BANDS:
        ref_band = band_level(ref_f, ref_psd, lo, hi) - ref_mid
        cap_band = band_level(cap_f, cap_psd, lo, hi) - cap_mid
        deltas.append(BandDelta(lo=lo, hi=hi, capture_minus_reference_db=cap_band - ref_band))
    return deltas
