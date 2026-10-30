"""Audit Linux ARM64 wheels, then install upstream unchanged and render."""
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import tomllib

out = Path('/artifacts')
out.mkdir(exist_ok=True)
source = Path('/opt/spektrafilm')
metadata = tomllib.loads((source / 'pyproject.toml').read_text())
report = {'architecture': platform.machine(), 'python': sys.version,
          'upstream_commit': subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(),
          'environment': 'linux-arm64 container; CI uses QEMU, not RK3588', 'wheels': []}
assert platform.machine() in ('aarch64', 'arm64'), report
for requirement in metadata['project']['dependencies']:
    started = time.monotonic()
    proc = subprocess.run([sys.executable, '-m', 'pip', 'download', '--only-binary=:all:', '--no-deps',
                           '--timeout', '30', '--retries', '1', '--dest', '/tmp/wheels', requirement],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    report['wheels'].append({'requirement': requirement, 'available': proc.returncode == 0,
                            'seconds': round(time.monotonic() - started, 2), 'log': proc.stdout})
    (out / 'dependencies.json').write_text(json.dumps(report, indent=2))
    print(f"WHEEL {requirement}: {'OK' if proc.returncode == 0 else 'UNAVAILABLE (see log)'}", flush=True)
# Binary-only installation makes missing wheels explicit rather than silently
# compiling large native dependencies and hiding the portability problem.
with (out / 'install.log').open('w') as log:
    installed = subprocess.run([sys.executable, '-m', 'pip', 'install', '--only-binary=:all:',
                                '--report', str(out / 'installed.json'), str(source)], stdout=log, stderr=subprocess.STDOUT)
report['full_install_passed'] = installed.returncode == 0
if installed.returncode:
    print('Full distribution failed; testing explicitly curated headless dependency set.', flush=True)
    # Exclude only desktop GUI and LUT-authoring extras. Runtime source and
    # profiles remain byte-for-byte upstream. Keep all numeric and image IO deps.
    omitted = {'qtpy', 'pyside6', 'napari', 'pyconify', 'markdown'}
    import re
    requirements = [r for r in metadata['project']['dependencies']
                    if re.split(r'[<>=!~\[ ]', r, maxsplit=1)[0].lower() not in omitted]
    report['headless_requirements'] = requirements
    report['omitted_desktop_requirements'] = sorted(omitted)
    (out / 'dependencies.json').write_text(json.dumps(report, indent=2))
    with (out / 'headless-install.log').open('w') as log:
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--only-binary=:all:',
                        '--report', str(out / 'headless-installed.json'), *requirements],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--no-deps', str(source)],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    # pip check still sees upstream desktop metadata; allow only those explicit
    # absent extras, never numeric ABI/version conflicts or other missing deps.
    checked = subprocess.run([sys.executable, '-m', 'pip', 'check'], capture_output=True, text=True)
    (out / 'pip-check.log').write_text(checked.stdout + checked.stderr)
    allowed = {f'spektrafilm 0.3.4 requires {name}, which is not installed.' for name in omitted}
    issues = checked.stdout.strip().splitlines() if checked.returncode else []
    if checked.stderr or any(line.lower() not in allowed for line in issues):
        raise RuntimeError('Unexpected dependency conflict: ' + checked.stdout + checked.stderr)
    report['install_mode'] = 'headless (desktop metadata omissions explicitly checked)'
else:
    subprocess.run([sys.executable, '-m', 'pip', 'check'], check=True)
    report['install_mode'] = 'full upstream distribution'
(out / 'dependencies.json').write_text(json.dumps(report, indent=2))
with (out / 'freeze.txt').open('w') as log:
    subprocess.run([sys.executable, '-m', 'pip', 'freeze'], stdout=log, check=True)
subprocess.run([sys.executable, '/poc/smoke.py'], check=True)
