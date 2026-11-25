"""Generate a three-frame HDR bracketing sample with a moving object.

The synthetic scene contains a bright window (clipped in the dark frame),
deep shadows (clipped in the bright frame) and a red ball that moves between
shots — so the set exercises both alignment and ghost marking. Each frame is
saved as a JPEG with real exposure EXIF tags and a small global camera shift.

Run:  python -m tools.make_samples
"""

from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

W, H = 960, 720
# (exposure_seconds, f_number, iso, global_camera_shift_px, ball_center_x)
# Shifts are applied in the linear-radiance domain and are large enough to
# survive JPEG compression, yet still within MTB's handheld-jitter range.
FRAMES = [
    (1 / 250.0, 5.6, 100, (0, 0), 240),       # dark / short exposure (reference)
    (1 / 60.0,  5.6, 100, (-9, 6), 430),      # middle
    (1 / 15.0,  5.6, 100, (7, -10), 620),     # bright / long exposure
]
OUT_DIR = Path(__file__).resolve().parent.parent / "samples"
NAMES = ["sample_dark.jpg", "sample_mid.jpg", "sample_bright.jpg"]


def build_scene() -> np.ndarray:
    """Linear-radiance scene, values roughly in [0, 1.6] (window clips)."""
    img = np.zeros((H, W, 3), np.float32)

    # Sky / wall background: vertical gradient, cool tone.
    grad = np.linspace(0.35, 0.12, H, dtype=np.float32)[:, None]
    img[..., 0] = grad * 0.75   # B
    img[..., 1] = grad * 0.85   # G
    img[..., 2] = grad          # R

    # Bright over-exposed window (high radiance -> clips on dark frames).
    img[90:330, 560:860] = (1.55, 1.50, 1.40)
    # Window cross frames.
    img[195:225, 560:860] = (0.25, 0.22, 0.18)
    img[90:330, 700:722] = (0.25, 0.22, 0.18)

    # Dark furniture block in the foreground (lifts only on the long shot).
    img[470:660, 90:360] = (0.045, 0.05, 0.06)
    # A mid-tone tabletop.
    pts = np.array([[120, 660], [840, 660], [720, 520], [240, 520]], np.int32)
    cv2.fillPoly(img, [pts], (0.28, 0.24, 0.20))
    # Lamp: small emissive sphere.
    cv2.circle(img, (480, 250), 34, (0.9, 0.85, 0.7), -1)
    cv2.circle(img, (480, 250), 46, (0.35, 0.32, 0.26), 8)
    return img


def place_ball(scene: np.ndarray, cx: int) -> np.ndarray:
    """Bright patterned moving ball with a soft shadow underneath.

    Saturated red plus a light checker pattern keeps the ball distinguishable
    from the dark background at *every* exposure, so ghost detection has a
    real structural signal to latch onto.
    """
    out = scene.copy()
    cy = 460
    radius = 62
    cv2.circle(out, (cx, cy + 72), radius + 6, (0.02, 0.02, 0.02), -1)       # shadow
    cv2.circle(out, (cx, cy), radius, (0.05, 0.05, 0.85), -1)                # red body (BGR)
    # Light checker cells clipped to the disc.
    yy, xx = np.ogrid[: out.shape[0], : out.shape[1]]
    inside = (xx - cx) ** 2 + (yy - cy) ** 2 <= (radius - 8) ** 2
    checker = (((xx // 22) + (yy // 22)) % 2 == 0) & inside
    out[checker] = (0.55, 0.55, 1.0)
    cv2.circle(out, (cx - 18, cy - 20), 16, (0.8, 0.8, 1.0), -1)            # highlight
    return out


def apply_exposure(scene: np.ndarray, seconds: float, f: float, iso: float) -> np.ndarray:
    """Simulate camera exposure: gain from the EV formula, clip, gamma.

    EV100 = log2(N^2/t) - log2(ISO/100). Doubling EV halves the captured
    signal, so gain scales as 2^-EV. The constant anchors the middle bracket
    (EV ~10.9) so an 18%-reflectance mid-tone lands near middle gray.
    """
    ev = math.log2((f * f) / seconds) - math.log2(iso / 100.0)
    gain = 1800.0 * 2.0 ** (-ev)        # mid frame (EV 10.88) -> gain ≈ 0.94
    exposed = np.clip(scene * gain, 0, 1)
    # Simple camera response: gamma plus a soft highlight roll-off.
    exposed = exposed ** (1 / 2.2)
    return (exposed * 255).astype(np.uint8)


def shift_image(img: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """Apply a global camera shift.

    Reflect-101 border avoids introducing artificial black edges (a constant
    border in 0..1 float would also be truncated to black on uint8 input and
    dominate alignment metrics).
    """
    m = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(img, m, (W, H), borderMode=cv2.BORDER_REFLECT_101)


def add_noise(img: np.ndarray, sigma: float = 2.2, seed: int | None = None) -> np.ndarray:
    # Independent RNG per frame: a shared fixed seed would stamp the *same*
    # noise pattern onto every exposure and let it dominate alignment metrics.
    rng = np.random.default_rng(seed)
    noise = rng.normal(0, sigma, img.shape)
    return np.clip(img.astype(np.float32) + noise, 0, 255).astype(np.uint8)


def write_with_exif(path: Path, img: np.ndarray, seconds: float,
                    f_number: float, iso: float) -> None:
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    with Image.fromarray(rgb) as im:
        exif = im.getexif()
        # Pillow IFD tags: ExposureTime=33434, FNumber=33437, ISOSpeedRatings=34855
        exif[33434] = (round(seconds * 1_000_000), 1_000_000)
        exif[33437] = (round(f_number * 10), 10)
        exif[34855] = int(iso)
        im.save(path, "JPEG", quality=95, exif=exif)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    base = build_scene()
    for k, ((seconds, f, iso, shift, ball_x), name) in enumerate(zip(FRAMES, NAMES)):
        frame = place_ball(base, ball_x)
        # Shift in the linear-radiance domain, before gamma and JPEG, so the
        # sub-pixel edge information survives the later compression.
        frame = shift_image(frame, *shift)
        frame = apply_exposure(frame, seconds, f, iso)
        frame = add_noise(frame, seed=1000 + k)
        path = OUT_DIR / name
        write_with_exif(path, frame, seconds, f, iso)
        print(f"wrote {path}  ({W}x{H}, {seconds:.4f}s, f/{f}, ISO {iso}, "
              f"shift={shift}, ball_x={ball_x})")
    print(f"\n样例已生成于 {OUT_DIR}，在界面中全部选中后建组即可体验完整流程。")


if __name__ == "__main__":
    main()
