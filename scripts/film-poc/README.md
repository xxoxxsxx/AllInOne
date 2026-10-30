# Film renderer Linux ARM64 proof of concept

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
