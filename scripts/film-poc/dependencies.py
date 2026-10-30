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
if installed.returncode:
    print((out / 'install.log').read_text()[-12000:], flush=True)
    sys.exit(installed.returncode)
subprocess.run([sys.executable, '-m', 'pip', 'check'], check=True)
subprocess.run([sys.executable, '/poc/smoke.py'], check=True)
