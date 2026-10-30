# Film renderer Linux ARM64 proof of concept

**Status: passed (2026-10-30, run
[41122787779](https://github.com/xxoxxsxx/AllInOne/actions/runs/41122787779)).**

Verified on linux/arm64 under QEMU (x86 runner), Python 3.13.18, pinned upstream
commit `3bb2c2d2801ff68b92019cf1dbcbb133d60832bc`:

| Finding | Result |
| --- | --- |
| aarch64 binary wheels for numpy/scipy/colour-science/scikit-image/matplotlib/numba/OpenImageIO/pyfftw/rawpy/exiv2/lensfunpy | **all available** |
| Full `pip install spektrafilm` on arm64 | **fails** — `pyside6~=6.9` has no aarch64 wheel (only a legacy 203.x is installable) |
| Headless install (upstream runtime + all numeric/IO deps, omitting only qtpy/pyside6/napari/pyconify/markdown) | **passes**; `pip check` shows exactly the omitted GUI extras, no other conflicts |
| 1 MP Portra 400 + Endura render | **succeeded**; finite, changed, non-constant output; 267 installed package files hash-match the pinned source; no GUI module imported |
| Measured on this runner (QEMU, 2 threads, **not** an RK3588 benchmark) | import 18.5 s, render 280 s, peak RSS 2.81 GiB, total 303 s |

Consequences for the production plan:

- The renderer image must use the **headless dependency set**; upstream's default
  dependency list cannot be installed on arm64 because of the PySide6 GUI extra.
  Pin the exact versions from `freeze.txt` of the passing run (numpy 2.5.4,
  numba 0.68.1, OpenImageIO 3.1.19.0, scipy 1.18.1, …) instead of upstream's
  floating `~=` ranges.
- QEMU numbers are a stress reference only. RK3588 timing/memory must be measured
  on the device before fixing queue concurrency and pixel caps; 2.8 GiB peak RSS
  for 1 MP suggests the 12 MP memory ceiling deserves a real measurement.

This is an isolated feasibility check, not an AllInOne feature or NAS deployment.
The workflow runs on an x86 GitHub runner with QEMU and executes a Linux ARM64
Python 3.13 container. Its timing and memory measurements are not RK3588 benchmarks.

Upstream is pinned to spektrafilm commit
`3bb2c2d2801ff68b92019cf1dbcbb133d60832bc`.

The container audits binary wheel availability for every upstream direct dependency,
then installs the unmodified upstream distribution with binary-only dependencies,
runs `pip check`, and executes the render smoke test. Wheel absence is recorded
as a portability finding rather than silently replaced with a different version.
Source compilation or an explicitly documented headless dependency set can be
investigated if the default install fails.

Run locally with Docker:

```sh
mkdir -p artifacts
docker build --platform linux/arm64 -t film-poc scripts/film-poc
docker run --rm --platform linux/arm64 --memory=6g --cpus=2 \
  -v "$PWD/artifacts:/artifacts" film-poc
```

CI uploads dependency audit, installation logs, renderer metrics and rendered images
as a 14-day artifact. No container image is pushed to the production registry.
Inputs are generated test patterns, not private photos. This does not validate RAW,
JPEG colour management, NAS performance, or equivalence with SpektraLab.

Upstream source and licensing:
https://github.com/andreavolpato/spektrafilm
Code is GPLv3; upstream profiles carry their own CC BY-SA 4.0 notices. Upstream
source/license files are retained in the test image; a future distributed renderer
must include the applicable notices and corresponding-source arrangements.
