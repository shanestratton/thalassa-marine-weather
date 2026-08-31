#!/usr/bin/env bash
# Regenerate the videoTrim test fixtures. Requires ffmpeg.
set -euo pipefail
cd "$(dirname "$0")/../tests/fixtures"
ffmpeg -y -loglevel error -f lavfi -i testsrc2=size=640x360:rate=30:duration=130 \
    -f lavfi -i sine=frequency=440:duration=130 \
    -c:v libx264 -g 30 -c:a aac -shortest trim-h264.mp4
ffmpeg -y -loglevel error -f lavfi -i testsrc2=size=640x360:rate=30:duration=130 \
    -f lavfi -i sine=frequency=440:duration=130 \
    -c:v hevc_videotoolbox -tag:v hvc1 -g 30 -c:a aac -shortest trim-hevc.mov
ls -la trim-*
