"""Recover the capture-to-reference lag and slice matched windows."""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast

import numpy as np

from .signal import CHANNELS, SAMPLE_RATE, FloatArray, center
from .transform import stereo_corr, transforms

BLOCK = 1024
FINE_ALIGN_SECONDS = 12.0
FINE_SEARCH_SECONDS = 2.0


@dataclass
class AlignedAudio:
    reference: FloatArray
    capture: FloatArray
    lag_frames: int
    seconds: float


def rms_envelope(audio: FloatArray, block: int = BLOCK) -> FloatArray:
    usable = (audio.shape[0] // block) * block
    if usable == 0:
        raise SystemExit("audio is too short")
    blocks = audio[:usable].reshape((-1, block, CHANNELS))
    env = np.sqrt(np.mean(np.sum(blocks * blocks, axis=2), axis=1))
    env -= np.mean(env)
    std = np.std(env)
    if std > 0:
        env /= std
    return cast(FloatArray, env)


def find_lag(reference: FloatArray, capture: FloatArray) -> int:
    ref_env = rms_envelope(reference)
    cap_env = rms_envelope(capture)
    corr = np.correlate(cap_env, ref_env, mode="full")
    lag_blocks = int(np.argmax(corr) - (ref_env.size - 1))
    return lag_blocks * BLOCK


def fft_valid_correlation(search: FloatArray, pattern: FloatArray) -> FloatArray:
    n = search.size + pattern.size - 1
    nfft = 1 << (n - 1).bit_length()
    conv = np.fft.irfft(np.fft.rfft(search, nfft) * np.fft.rfft(pattern[::-1], nfft), nfft)
    return cast(FloatArray, conv[pattern.size - 1 : search.size])


def fine_tune_lag(reference: FloatArray, capture: FloatArray, coarse_lag: int) -> int:
    ref_len = min(int(FINE_ALIGN_SECONDS * SAMPLE_RATE), reference.shape[0])
    radius = int(FINE_SEARCH_SECONDS * SAMPLE_RATE)
    if ref_len < SAMPLE_RATE * 3:
        return coarse_lag

    ref_start = max(0, -coarse_lag)
    cap_center = max(0, coarse_lag)
    if ref_start + ref_len >= reference.shape[0]:
        ref_start = max(0, reference.shape[0] - ref_len - 1)

    search_start = max(0, cap_center - radius)
    search_end = min(capture.shape[0], cap_center + radius + ref_len)
    if search_end - search_start < ref_len:
        return coarse_lag

    ref = center(reference[ref_start : ref_start + ref_len])
    search = capture[search_start:search_end]

    best_score = -float("inf")
    best_offset = cap_center
    for candidate in transforms(search).values():
        cand = center(candidate)
        score = fft_valid_correlation(cand[:, 0], ref[:, 0]) + fft_valid_correlation(cand[:, 1], ref[:, 1])
        offset = int(np.argmax(score)) + search_start
        value = float(np.max(score))
        if value > best_score:
            best_score = value
            best_offset = offset

    return best_offset - ref_start


def align(
    reference: FloatArray, capture: FloatArray, skip_seconds: float, max_seconds: float, lag: int | None = None
) -> AlignedAudio:
    if lag is None:
        coarse_lag = find_lag(reference, capture)
        lag = fine_tune_lag(reference, capture, coarse_lag)
    ref_start = max(0, -lag)
    cap_start = max(0, lag)
    skip = int(skip_seconds * SAMPLE_RATE)
    ref_start += skip
    cap_start += skip
    frames = min(reference.shape[0] - ref_start, capture.shape[0] - cap_start)
    frames = min(frames, int(max_seconds * SAMPLE_RATE))
    if frames < SAMPLE_RATE * 5:
        raise SystemExit(f"not enough aligned audio for analysis: {frames / SAMPLE_RATE:.2f}s")
    return AlignedAudio(
        reference=reference[ref_start : ref_start + frames],
        capture=capture[cap_start : cap_start + frames],
        lag_frames=lag,
        seconds=frames / SAMPLE_RATE,
    )


def scan_lags(
    reference: FloatArray,
    capture: FloatArray,
    center_lag: int,
    radius_seconds: float,
    step_seconds: float,
    max_seconds: float,
) -> int:
    radius = int(radius_seconds * SAMPLE_RATE)
    step = max(1, int(step_seconds * SAMPLE_RATE))
    window = min(int(max_seconds * SAMPLE_RATE), int(20 * SAMPLE_RATE), reference.shape[0], capture.shape[0])
    if window < SAMPLE_RATE * 5:
        return center_lag

    best_lag = center_lag
    best_score = -float("inf")
    rows = []
    for lag in range(center_lag - radius, center_lag + radius + 1, step):
        ref_start = max(0, -lag)
        cap_start = max(0, lag)
        frames = min(reference.shape[0] - ref_start, capture.shape[0] - cap_start, window)
        if frames < SAMPLE_RATE * 5:
            continue
        ref = reference[ref_start : ref_start + frames]
        cap = capture[cap_start : cap_start + frames]
        score = max(stereo_corr(ref, candidate) for candidate in transforms(cap).values())
        rows.append((score, lag))
        if score > best_score:
            best_score = score
            best_lag = lag

    print("\nLag scan, best simple-transform correlation:")
    for score, lag in sorted(rows, reverse=True)[:10]:
        print(f"  lag={lag / SAMPLE_RATE:+8.3f}s  corr={score:+.4f}")
    return best_lag
