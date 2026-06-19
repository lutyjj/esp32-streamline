#!/usr/bin/env python3
"""Compare an ESP32 StreamLine capture against a known reference track."""

from __future__ import annotations

import argparse
import math
import pathlib
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Any, cast

import numpy as np
import numpy.typing as npt

SAMPLE_RATE = 48_000
CHANNELS = 2
BLOCK = 1024
FINE_ALIGN_SECONDS = 12.0
FINE_SEARCH_SECONDS = 2.0
type FloatArray = npt.NDArray[np.floating[Any]]


@dataclass
class AlignedAudio:
    reference: FloatArray
    capture: FloatArray
    lag_frames: int
    seconds: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", required=True, help="reference FLAC/WAV/etc")
    parser.add_argument("--capture", required=True, help="ESP capture WAV or raw s16le")
    parser.add_argument("--capture-raw", action="store_true", help="capture is raw s16le stereo 48 kHz")
    parser.add_argument("--max-seconds", type=float, default=120.0, help="maximum aligned audio to analyze")
    parser.add_argument("--skip-seconds", type=float, default=2.0, help="skip this much after alignment")
    parser.add_argument("--lag-seconds", type=float, help="manual capture-start minus reference-start offset")
    parser.add_argument(
        "--scan-lag", type=float, default=0.0, help="scan +/- this many seconds around the selected lag"
    )
    parser.add_argument("--scan-step", type=float, default=0.25, help="lag scan step in seconds")
    return parser.parse_args()


def decode_with_ffmpeg(path: pathlib.Path) -> FloatArray:
    with tempfile.NamedTemporaryFile(suffix=".f32le") as tmp:
        cmd = [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-ac",
            str(CHANNELS),
            "-ar",
            str(SAMPLE_RATE),
            "-f",
            "f32le",
            tmp.name,
        ]
        subprocess.run(cmd, check=True)
        data = np.fromfile(tmp.name, dtype=np.float32)
    if data.size % CHANNELS:
        data = data[: data.size - (data.size % CHANNELS)]
    return cast(FloatArray, data.reshape((-1, CHANNELS)))


def read_raw_s16le(path: pathlib.Path) -> FloatArray:
    data = np.fromfile(path, dtype="<i2")
    if data.size % CHANNELS:
        data = data[: data.size - (data.size % CHANNELS)]
    return data.reshape((-1, CHANNELS)).astype(np.float32) / 32768.0


def load_capture(path: pathlib.Path, raw: bool) -> FloatArray:
    if raw or path.suffix.lower() in {".raw", ".pcm", ".s16le"}:
        return read_raw_s16le(path)
    return decode_with_ffmpeg(path)


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


def stereo_corr(reference: FloatArray, capture: FloatArray) -> float:
    ref = center(reference)
    cap = center(capture)
    return float(
        np.dot(ref.ravel(), cap.ravel())
        / max(
            math.sqrt(float(np.dot(ref.ravel(), ref.ravel())) * float(np.dot(cap.ravel(), cap.ravel()))),
            1e-12,
        )
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


def center(audio: FloatArray) -> FloatArray:
    return cast(FloatArray, audio - np.mean(audio, axis=0, keepdims=True))


def transforms(capture: FloatArray) -> dict[str, FloatArray]:
    left = capture[:, 0]
    right = capture[:, 1]
    return {
        "normal": cast(FloatArray, np.column_stack([left, right])),
        "swap_lr": cast(FloatArray, np.column_stack([right, left])),
        "invert_left": cast(FloatArray, np.column_stack([-left, right])),
        "invert_right": cast(FloatArray, np.column_stack([left, -right])),
        "invert_both": cast(FloatArray, np.column_stack([-left, -right])),
        "swap_invert_left": cast(FloatArray, np.column_stack([-right, left])),
        "swap_invert_right": cast(FloatArray, np.column_stack([right, -left])),
        "mono_sum": cast(FloatArray, np.column_stack([(left + right) * 0.5, (left + right) * 0.5])),
        "mono_difference": cast(FloatArray, np.column_stack([(left - right) * 0.5, (left - right) * 0.5])),
    }


def score_transform(reference: FloatArray, candidate: FloatArray) -> tuple[float, float, FloatArray]:
    ref = center(reference)
    cand = center(candidate)
    gains = cast(FloatArray, np.zeros(CHANNELS, dtype=np.float64))
    corrected = np.zeros_like(cand)
    for channel in range(CHANNELS):
        denom = float(np.dot(cand[:, channel], cand[:, channel]))
        unconstrained = 0.0 if denom == 0 else float(np.dot(ref[:, channel], cand[:, channel]) / denom)
        gains[channel] = max(0.0, unconstrained)
        corrected[:, channel] = cand[:, channel] * gains[channel]
    err = ref - corrected
    nrmse = math.sqrt(float(np.mean(err * err)) / max(float(np.mean(ref * ref)), 1e-12))
    corr = float(
        np.dot(ref.ravel(), corrected.ravel())
        / max(
            math.sqrt(float(np.dot(ref.ravel(), ref.ravel())) * float(np.dot(corrected.ravel(), corrected.ravel()))),
            1e-12,
        )
    )
    return nrmse, corr, gains


def fitted_matrix(reference: FloatArray, capture: FloatArray) -> FloatArray:
    ref = center(reference)
    cap = center(capture)
    matrix, _residuals, _rank, _s = np.linalg.lstsq(ref, cap, rcond=None)
    return matrix.T


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


def print_frequency_delta(reference: FloatArray, capture: FloatArray) -> None:
    ref_f, ref_psd = mono_bands(reference)
    cap_f, cap_psd = mono_bands(capture)
    bands = [(20, 60), (60, 120), (120, 250), (250, 1000), (1000, 5000), (5000, 15000)]
    ref_mid = band_level(ref_f, ref_psd, 250, 1000)
    cap_mid = band_level(cap_f, cap_psd, 250, 1000)
    print("\nFrequency response, mono, relative to 250-1000 Hz:")
    for lo, hi in bands:
        ref_band = band_level(ref_f, ref_psd, lo, hi) - ref_mid
        cap_band = band_level(cap_f, cap_psd, lo, hi) - cap_mid
        print(f"  {lo:5.0f}-{hi:<5.0f} Hz  capture-reference {cap_band - ref_band:+6.2f} dB")


def print_mid_side(label: str, audio: FloatArray) -> None:
    mid = (audio[:, 0] + audio[:, 1]) * 0.5
    side = (audio[:, 0] - audio[:, 1]) * 0.5
    ratio = rms_db(side) - rms_db(mid)
    print(f"  {label:<10} mid_rms={rms_db(mid):7.2f} dBFS  side-mid={ratio:+6.2f} dB")


def print_basic_stats(label: str, audio: FloatArray) -> None:
    clips = np.sum(np.abs(audio) >= 0.999)
    dc = np.mean(audio, axis=0)
    print(
        f"  {label:<10} peak L/R={peak_db(audio[:, 0]):6.2f}/{peak_db(audio[:, 1]):6.2f} dBFS  "
        f"rms L/R={rms_db(audio[:, 0]):6.2f}/{rms_db(audio[:, 1]):6.2f} dBFS  "
        f"dc L/R={dc[0]:+.5f}/{dc[1]:+.5f}  clips={int(clips)}"
    )


def main() -> int:
    args = parse_args()
    reference_path = pathlib.Path(args.reference)
    capture_path = pathlib.Path(args.capture)

    reference = decode_with_ffmpeg(reference_path)
    capture = load_capture(capture_path, args.capture_raw)
    lag = None
    if args.lag_seconds is not None:
        lag = int(args.lag_seconds * SAMPLE_RATE)
        if args.scan_lag > 0:
            lag = scan_lags(reference, capture, lag, args.scan_lag, args.scan_step, args.max_seconds)
    aligned = align(reference, capture, args.skip_seconds, args.max_seconds, lag=lag)

    print(f"Reference: {reference_path}")
    print(f"Capture:   {capture_path}")
    print(f"Aligned:   lag={aligned.lag_frames / SAMPLE_RATE:+.3f}s  analyzed={aligned.seconds:.2f}s")

    print("\nBasic stats:")
    print_basic_stats("reference", aligned.reference)
    print_basic_stats("capture", aligned.capture)

    print("\nMid/side balance:")
    print_mid_side("reference", aligned.reference)
    print_mid_side("capture", aligned.capture)

    print("\nChannel transform scores, lower NRMSE and higher corr are better:")
    scored = []
    for name, candidate in transforms(aligned.capture).items():
        nrmse, corr, gains = score_transform(aligned.reference, candidate)
        scored.append((nrmse, -corr, name, corr, gains, candidate))
        print(f"  {name:<18} nrmse={nrmse:6.3f}  corr={corr:7.4f}  gains L/R={gains[0]:+.3f}/{gains[1]:+.3f}")
    scored.sort()
    _nrmse, _neg_corr, best_name, best_corr, best_gains, best_candidate = scored[0]

    corrected = best_candidate.copy()
    corrected[:, 0] *= best_gains[0]
    corrected[:, 1] *= best_gains[1]
    print(f"\nBest simple transform: {best_name} (corr={best_corr:.4f})")

    matrix = fitted_matrix(aligned.reference, aligned.capture)
    scale = max(float(np.max(np.abs(matrix))), 1e-12)
    print("\nBest-fit stereo matrix, capture ~= matrix * reference:")
    print(f"  raw:        [{matrix[0, 0]:+.4f} {matrix[0, 1]:+.4f}]")
    print(f"              [{matrix[1, 0]:+.4f} {matrix[1, 1]:+.4f}]")
    print(f"  normalized: [{matrix[0, 0] / scale:+.3f} {matrix[0, 1] / scale:+.3f}]")
    print(f"              [{matrix[1, 0] / scale:+.3f} {matrix[1, 1] / scale:+.3f}]")

    print_frequency_delta(aligned.reference, corrected)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
