"""Download the CC0 ambientCG textures used by the terrain splat material.

Only the Color and NormalGL maps are kept, re-encoded to 1024px JPG so the
committed assets stay small. The processed files live in public/textures and
are committed, so running this is only needed to refresh or replace them.

Usage: python scripts/fetch-textures.py [--size 1024] [--quality 5]
Requires: python 3, ffmpeg on PATH (used for resize/re-encode).
"""
from __future__ import annotations

import argparse
import io
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ASSETS = {
    # role: ambientCG asset id
    "grass_fairway": "Grass005",
    "grass_green": "Grass008",
    "grass_rough": "Grass004",
    "sand_bunker": "Ground101",
}
MAPS = {"Color": "color", "NormalGL": "normal"}
OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "textures"


def download(asset_id: str) -> bytes:
    url = f"https://ambientcg.com/get?file={asset_id}_1K-JPG.zip"
    print(f"downloading {url}")
    # The download CDN answers 403 to urllib's default user agent.
    request = urllib.request.Request(url, headers={"User-Agent": "golf-simulator-fetch-textures/1.0"})
    with urllib.request.urlopen(request) as response:
        return response.read()


def reencode(source: bytes, target: Path, size: int, quality: int) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        print("ffmpeg not found; writing original file unchanged", file=sys.stderr)
        target.write_bytes(source)
        return
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-i", "pipe:0",
         "-vf", f"scale={size}:{size}", "-q:v", str(quality), str(target)],
        input=source,
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--size", type=int, default=1024)
    parser.add_argument("--quality", type=int, default=5, help="ffmpeg -q:v (2 best, 31 worst)")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for role, asset_id in ASSETS.items():
        archive = zipfile.ZipFile(io.BytesIO(download(asset_id)))
        for map_name, suffix in MAPS.items():
            member = f"{asset_id}_1K-JPG_{map_name}.jpg"
            target = OUT_DIR / f"{role}_{suffix}.jpg"
            reencode(archive.read(member), target, args.size, args.quality)
            print(f"  wrote {target.name} ({target.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
