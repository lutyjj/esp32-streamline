"""Score simple channel transforms of the capture against the reference."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import cast

import numpy as np

from .signal import CHANNELS, FloatArray, center


@dataclass
class TransformScore:
    """How well one simple channel transform matches the reference."""

    name: str
    nrmse: float
    corr: float
    gains: tuple[float, float]


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


def score_transforms(reference: FloatArray, capture: FloatArray) -> list[TransformScore]:
    """Score every simple channel transform of the capture against the reference."""
    scores = []
    for name, candidate in transforms(capture).items():
        nrmse, corr, gains = score_transform(reference, candidate)
        scores.append(TransformScore(name=name, nrmse=nrmse, corr=corr, gains=(float(gains[0]), float(gains[1]))))
    return scores


def best_transform(scores: list[TransformScore]) -> TransformScore:
    """Pick the closest transform: lowest NRMSE, then highest correlation."""
    return min(scores, key=lambda score: (score.nrmse, -score.corr, score.name))


def fitted_matrix(reference: FloatArray, capture: FloatArray) -> FloatArray:
    ref = center(reference)
    cap = center(capture)
    matrix, _residuals, _rank, _s = np.linalg.lstsq(ref, cap, rcond=None)
    return matrix.T
