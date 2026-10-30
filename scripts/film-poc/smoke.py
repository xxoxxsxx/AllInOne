#!/usr/bin/env python3
"""Headless, pinned spektrafilm smoke test; not a JPEG or RK3588 benchmark.

Run with /venv/bin/python /poc/smoke.py. Requires the clean pinned checkout
(including .git) at /opt/spektrafilm, git on PATH, and that package installed
into this interpreter. Writes linear .npy arrays, an sRGB PNG preview, and
metrics.json under /artifacts. No GUI entry points or image decoders are used.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import resource
import struct
import subprocess
import sys
import time
import traceback
import zlib

COMMIT = "3bb2c2d2801ff68b92019cf1dbcbb133d60832bc"
FILM = "kodak_portra_400"
PAPER = "kodak_portra_endura"


def git(source: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(source), *args], text=True, stderr=subprocess.STDOUT
    ).strip()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_checkout(source: Path) -> list[str]:
    head = git(source, "rev-parse", "HEAD")
    if head != COMMIT:
        raise RuntimeError(f"Source pin mismatch: expected {COMMIT}, got {head}")
    if git(source, "status", "--porcelain", "--untracked-files=no"):
        raise RuntimeError("Pinned source has modified tracked files")
    tracked = git(source, "ls-files", "src/spektrafilm").splitlines()
    # Setuptools includes Python modules and declared data/**/*, not the
    # package's developer README. Compare all installed runtime sources/assets.
    files = [name for name in tracked if name.endswith(".py") or name.startswith("src/spektrafilm/data/")]
    if not files:
        raise RuntimeError("Pinned checkout has no tracked spektrafilm package files")
    return files


def verify_installed(source: Path, installed: Path, files: list[str]) -> int:
    # Verifies the actually imported package, not merely a nearby git checkout.
    for name in files:
        relative = Path(name).relative_to("src/spektrafilm")
        original, imported = source / name, installed / relative
        if not imported.is_file() or sha256(original) != sha256(imported):
            raise RuntimeError(f"Installed package differs from pinned source: {relative}")
    return len(files)


def write_png(path: Path, linear, np) -> None:
    """Encode a viewable 8-bit sRGB PNG; keep unclipped linear output separately."""
    rgb = np.clip(linear, 0.0, 1.0)
    encoded = np.where(rgb <= 0.0031308, 12.92 * rgb,
                       1.055 * np.power(rgb, 1.0 / 2.4) - 0.055)
    pixels = np.rint(encoded * 255).astype(np.uint8)
    height, width, _ = pixels.shape

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    rows = b"".join(b"\x00" + row.tobytes() for row in pixels)
    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                     + chunk(b"sRGB", b"\x00")
                     + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=Path("/opt/spektrafilm"))
    parser.add_argument("--output-dir", type=Path, default=Path("/artifacts"))
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    metrics = {
        "status": "failed", "expected_commit": COMMIT,
        "python": sys.version, "platform": platform.platform(),
        "machine": platform.machine(), "film": FILM, "paper": PAPER,
        "shape": [1024, 1024, 3], "pixels": 1048576,
        "input": "generated float32 linear sRGB primaries (no image decoder)",
        "output": "linear sRGB .npy plus clipped, sRGB-encoded PNG preview",
        "jpeg_verified": False, "hardware_performance_claim": False,
        "stochastic_effects": False, "spatial_effects": True,
        "notes": ["One simulate call; includes lazy JIT/LUT costs, no explicit warmup.",
                  "Existing on-disk caches may affect timing; no cold-cache claim.",
                  "Peak RSS is process lifetime high-water mark, not container memory.",
                  "This is not grain/glare coverage or an upstream parity test."],
    }
    try:
        if sys.version_info[:2] != (3, 13):
            raise RuntimeError("PoC requires Python 3.13 exactly")
        files = verify_checkout(args.source_dir)
        # Set before importing numerical libraries. Honor explicit caller tuning.
        for variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMBA_NUM_THREADS"):
            os.environ.setdefault(variable, "1")
        os.environ["MPLBACKEND"] = "Agg"
        os.environ["QT_QPA_PLATFORM"] = "offscreen"
        metrics["thread_environment"] = {key: os.environ[key] for key in
            ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMBA_NUM_THREADS")}
        tick = time.perf_counter()
        import numpy as np
        import spektrafilm
        from spektrafilm import digest_params, init_params, simulate
        metrics["import_seconds"] = time.perf_counter() - tick
        package = Path(spektrafilm.__file__).resolve().parent
        metrics["installed_package"] = str(package)
        metrics["package_version"] = importlib.metadata.version("spektrafilm")
        metrics["verified_package_files"] = verify_installed(args.source_dir, package, files)
        metrics["verified_commit"] = COMMIT

        tick = time.perf_counter()
        # Smooth channel ramps, chromatic patches and highlights; no RNG required.
        y, x = np.mgrid[0:1024, 0:1024].astype(np.float32) / np.float32(1023)
        image = np.stack((0.015 + 0.8 * x, 0.02 + 0.7 * y,
                          0.025 + 0.55 * (1 - x) * (1 - y)), axis=-1)
        image[96:288, 96:288] = (0.65, 0.05, 0.03)
        image[96:288, 736:928] = (0.04, 0.5, 0.08)
        image[736:928, 96:288] = (0.025, 0.07, 0.65)
        image[736:928, 736:928] = (0.95, 0.95, 0.95)
        image = np.ascontiguousarray(image, dtype=np.float32)
        reference = image.copy()  # compare to original even if upstream mutates input
        np.save(args.output_dir / "input-linear-srgb.npy", reference, allow_pickle=False)
        params = init_params(film_profile=FILM, print_profile=PAPER)
        metrics["upstream_io_defaults"] = {
            key: getattr(params.io, key) for key in
            ("input_color_space", "input_cctf_decoding", "output_color_space", "output_cctf_encoding")
        }
        params.io.input_color_space = "sRGB"
        params.io.input_cctf_decoding = False
        params.io.output_color_space = "sRGB"
        params.io.output_cctf_encoding = False
        params.io.crop = False
        params.io.upscale_factor = 1.0
        params.io.scan_film = False
        params.settings.preview_mode = False
        # NumPy seeding does not reliably seed Numba RNG. Turn off stochastic
        # grain/glare explicitly while retaining the actual spatial film pipeline.
        params.debug.deactivate_stochastic_effects = True
        params.debug.deactivate_spatial_effects = False
        params = digest_params(params)
        metrics["setup_seconds"] = time.perf_counter() - tick
        tick = time.perf_counter()
        output = np.asarray(simulate(image, params, digest_params_first=False))
        metrics["render_seconds"] = time.perf_counter() - tick
        if output.shape != reference.shape or not np.isfinite(output).all():
            raise RuntimeError(f"Invalid output shape or nonfinite pixels: {output.shape}")
        delta = np.abs(output.astype(np.float64) - reference)
        channel_std = np.std(output, axis=(0, 1))
        if not np.all(channel_std > 1e-6):
            raise RuntimeError("Rendered image has a constant channel")
        if float(delta.mean()) <= 1e-5 or np.allclose(output, reference, rtol=1e-5, atol=1e-6):
            raise RuntimeError("Rendered image is unchanged from input")
        if any(name == "napari" or name.startswith(("napari.", "PySide6")) for name in sys.modules):
            raise RuntimeError("Unexpected GUI module loaded by headless pipeline")
        metrics["validation"] = {
            "finite": True, "shape_matches": True, "changed": True, "nonconstant": True,
            "minimum": float(output.min()), "maximum": float(output.max()),
            "channel_std": channel_std.tolist(), "mean_absolute_change": float(delta.mean()),
            "max_absolute_change": float(delta.max()), "dtype": str(output.dtype),
        }
        np.save(args.output_dir / "output-linear-srgb.npy", output, allow_pickle=False)
        write_png(args.output_dir / "output-preview-srgb.png", output, np)
        metrics["artifacts"] = {name: {"sha256": sha256(args.output_dir / name),
            "bytes": (args.output_dir / name).stat().st_size} for name in
            ("input-linear-srgb.npy", "output-linear-srgb.npy", "output-preview-srgb.png")}
        metrics["status"] = "passed"
    except Exception as error:
        metrics["error"] = f"{type(error).__name__}: {error}"
        traceback.print_exc()
    finally:
        metrics["total_seconds"] = time.perf_counter() - started
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        metrics["peak_rss_bytes"] = int(rss if sys.platform == "darwin" else rss * 1024)
        metrics["peak_rss_mib"] = metrics["peak_rss_bytes"] / (1024 * 1024)
        (args.output_dir / "metrics.json").write_text(
            json.dumps(metrics, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        print(json.dumps(metrics, allow_nan=False), flush=True)
    return 0 if metrics["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
