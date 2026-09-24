#!/usr/bin/env python3
"""Rebuild the bundled native filter; only needed by developers, not installation."""
import json, hashlib, shutil, subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[1]
clang = shutil.which('clang')
if not clang:
    raise SystemExit('clang with the wasm32 target and wasm-ld is required to rebuild.')
base = [clang, '--target=wasm32', '-O3', '-fno-fast-math', '-ffp-contract=off', '-nostdlib', '-fno-builtin',
        '-Wl,--no-entry', '-Wl,--export=refiner_abi', '-Wl,--export=heap_base', '-Wl,--export=refine', '-Wl,--export-memory',
        '-Wl,--initial-memory=131072', '-Wl,--max-memory=268435456', '-Wl,-z,stack-size=65536',
        '-Wl,--strip-all', str(root/'native/refiner.c')]
outputs = {}
for name, extra in [('refiner-simd.wasm',['-msimd128']),('refiner.wasm',[])]:
    out = root/'extension/native'/name
    out.parent.mkdir(exist_ok=True)
    subprocess.run(base + extra + ['-o',str(out)], check=True)
    outputs[name] = {'size':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest()}
report={'compiler':subprocess.check_output([clang,'--version'],text=True).splitlines()[0],
        'sourceSHA256':hashlib.sha256((root/'native/refiner.c').read_bytes()).hexdigest(), 'outputs':outputs}
(root/'native/BUILD.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
