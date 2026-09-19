#!/usr/bin/env python3
"""Copy an original panorama MP4 into its viewpoint and record its provenance without re-encoding."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('viewpoint', choices=['cesta-k-parku', 'hriste'])
    parser.add_argument('source', type=Path)
    args = parser.parse_args()
    if args.source.stat().st_size >= 100 * 1024 * 1024:
        parser.error('The MP4 exceeds the GitHub per-file size limit.')
    probe = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(args.source),
    ]))
    videos = [stream for stream in probe['streams'] if stream['codec_type'] == 'video']
    if len(videos) != 1 or videos[0]['width'] != videos[0]['height'] * 2:
        parser.error('Expected one full 2:1 panorama video stream.')
    video = videos[0]
    destination = ROOT / 'assets' / f'{args.viewpoint}.mp4'
    shutil.copyfile(args.source, destination)
    with destination.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    manifest = ROOT / 'content-provenance.json'
    provenance = json.loads(manifest.read_text())
    record = {
        'id': args.viewpoint, 'sourceFilename': args.source.name,
        'path': destination.relative_to(ROOT).as_posix(), 'bytes': destination.stat().st_size,
        'sha256': digest, 'sourceSha256': digest, 'transcoded': False,
        'width': video['width'], 'height': video['height'], 'codec': video['codec_name'],
        'pixelFormat': video['pix_fmt'], 'frameRate': video['r_frame_rate'],
        'durationSeconds': float(probe['format']['duration']),
    }
    provenance['videos'] = [item for item in provenance.get('videos', []) if item['id'] != args.viewpoint] + [record]
    manifest.write_text(json.dumps(provenance, indent=2) + '\n')
    print(json.dumps(record, indent=2))


if __name__ == '__main__':
    main()
