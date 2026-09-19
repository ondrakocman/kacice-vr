#!/usr/bin/env python3
"""Prepare the approved Kačice stills; source PNGs remain outside the web repository."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCES = {
    'cesta-k-parku': 'kacice cesta park(1).png',
    'hriste': 'Hriste kacice fin(1).png',
}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_directory', type=Path)
    args = parser.parse_args()
    provenance = {'sources': [], 'generated': [], 'cubeSizes': [2048, 2560]}
    assets = ROOT / 'assets'
    assets.mkdir(exist_ok=True)
    for identifier, filename in SOURCES.items():
        source = args.source_directory / filename
        with Image.open(source) as image:
            if image.width != image.height * 2:
                raise ValueError(f'Expected a complete 2:1 panorama: {filename}')
            provenance['sources'].append({
                'id': identifier, 'filename': filename, 'width': image.width,
                'height': image.height, 'sha256': digest(source),
            })
            # A common 8K fallback avoids oversized textures and dimension changes on switching.
            fallback = image.convert('RGB').resize((8192, 4096), Image.Resampling.LANCZOS)
            fallback.save(assets / f'{identifier}.webp', quality=95, method=6)
            fallback.close()
        # Generate cube faces directly from the full-resolution original, never the resized fallback.
        for size in provenance['cubeSizes']:
            subprocess.run([
                sys.executable, str(ROOT / 'tools/gen_cube.py'), str(source),
                str(assets / 'cube'), f'{identifier}-{size}', str(size), '92',
            ], check=True)
    for path in sorted(assets.rglob('*.webp')):
        with Image.open(path) as image:
            provenance['generated'].append({
                'path': path.relative_to(ROOT).as_posix(), 'bytes': path.stat().st_size,
                'width': image.width, 'height': image.height, 'sha256': digest(path),
            })
    (ROOT / 'content-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')


if __name__ == '__main__':
    main()
