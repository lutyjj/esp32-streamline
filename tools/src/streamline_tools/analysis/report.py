"""Compare an ESP32 StreamLine capture against a known reference track."""

from __future__ import annotations

import argparse
import pathlib

import numpy as np

from .align import align, scan_lags
from .decode import decode_with_ffmpeg, load_capture
from .measure import BandDelta, ChannelStats, MidSideBalance, basic_stats, frequency_delta, mid_side
from .signal import SAMPLE_RATE
from .transform import TransformScore, best_transform, fitted_matrix, score_transforms, transforms


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


def format_basic_stats(label: str, stats: ChannelStats) -> str:
    return (
        f"  {label:<10} peak L/R={stats.peak_dbfs[0]:6.2f}/{stats.peak_dbfs[1]:6.2f} dBFS  "
        f"rms L/R={stats.rms_dbfs[0]:6.2f}/{stats.rms_dbfs[1]:6.2f} dBFS  "
        f"dc L/R={stats.dc_offset[0]:+.5f}/{stats.dc_offset[1]:+.5f}  clips={stats.clips}"
    )


def format_mid_side(label: str, balance: MidSideBalance) -> str:
    return f"  {label:<10} mid_rms={balance.mid_rms_dbfs:7.2f} dBFS  side-mid={balance.side_minus_mid_db:+6.2f} dB"


def format_transform_score(score: TransformScore) -> str:
    return (
        f"  {score.name:<18} nrmse={score.nrmse:6.3f}  corr={score.corr:7.4f}  "
        f"gains L/R={score.gains[0]:+.3f}/{score.gains[1]:+.3f}"
    )


def format_frequency_delta(delta: BandDelta) -> str:
    return f"  {delta.lo:5.0f}-{delta.hi:<5.0f} Hz  capture-reference {delta.capture_minus_reference_db:+6.2f} dB"


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
    print(format_basic_stats("reference", basic_stats(aligned.reference)))
    print(format_basic_stats("capture", basic_stats(aligned.capture)))

    print("\nMid/side balance:")
    print(format_mid_side("reference", mid_side(aligned.reference)))
    print(format_mid_side("capture", mid_side(aligned.capture)))

    print("\nChannel transform scores, lower NRMSE and higher corr are better:")
    scores = score_transforms(aligned.reference, aligned.capture)
    for score in scores:
        print(format_transform_score(score))
    best = best_transform(scores)

    corrected = transforms(aligned.capture)[best.name].copy()
    corrected[:, 0] *= best.gains[0]
    corrected[:, 1] *= best.gains[1]
    print(f"\nBest simple transform: {best.name} (corr={best.corr:.4f})")

    matrix = fitted_matrix(aligned.reference, aligned.capture)
    scale = max(float(np.max(np.abs(matrix))), 1e-12)
    print("\nBest-fit stereo matrix, capture ~= matrix * reference:")
    print(f"  raw:        [{matrix[0, 0]:+.4f} {matrix[0, 1]:+.4f}]")
    print(f"              [{matrix[1, 0]:+.4f} {matrix[1, 1]:+.4f}]")
    print(f"  normalized: [{matrix[0, 0] / scale:+.3f} {matrix[0, 1] / scale:+.3f}]")
    print(f"              [{matrix[1, 0] / scale:+.3f} {matrix[1, 1] / scale:+.3f}]")

    print("\nFrequency response, mono, relative to 250-1000 Hz:")
    for delta in frequency_delta(aligned.reference, corrected):
        print(format_frequency_delta(delta))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
