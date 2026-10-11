"""Download and process the CC0 assets used by the renderer.

Processed files live in public/ and are committed, so running this is only
needed to refresh or replace them. Every asset is recorded in public/LICENSE.md.

Usage: python scripts/fetch-assets.py [vegetation]
  With "vegetation", only the foliage and bark textures are refreshed.
Requires: python 3, ffmpeg and ffprobe on PATH (decode the HDRI).
"""
from __future__ import annotations

import io
import json
import math
import struct
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
USER_AGENT = "golf-simulator-fetch-assets/1.0"

# Poly Haven HDRI used for the sky dome and image-based lighting.
HDRI_ID = "kloofendal_48d_partly_cloudy_puresky"
HDRI_RESOLUTION = "2k"
HDRI_OUT = PUBLIC / "environment" / "sky.hdr"

# The real sun is tens of thousands of times brighter than the sky. Left in,
# image-based lighting would light every surface with it a second time, on top
# of the shadow-casting directional light, and wash out the shadows. Pixels
# above this luminance are scaled down to it: the disc stays visible in the
# sky and still blooms, but its energy comes from the directional light.
SUN_LUMINANCE_CAP = 12.0

# Rows around the horizon averaged for the fog colour.
HORIZON_BAND = (0.47, 0.5)

# ambientCG materials for the terrain, one per texture layer. The renderer
# colours each surface itself, so the albedo map is turned into a "detail"
# map: linear colour divided by its own mean and scaled to 0.5, i.e. only the
# variation around the average survives (see normalise_detail).
TERRAIN_TEXTURES = {
    # layer: ambientCG asset id
    "rough": "Grass004",
    "fairway": "Grass005",
    "green": "Grass008",
    "sand": "Ground101",
}
TERRAIN_TEXTURE_SIZE = 1024
TERRAIN_OUT = PUBLIC / "textures" / "terrain"
# Mean of a normalised detail map, as a byte. The shader multiplies by 2.
DETAIL_MEAN = 0.5
JPEG_QUALITY = "3"

# ambientCG cut-out atlases for foliage. Each becomes an RGBA WebP (colour +
# opacity) plus the bounding boxes of its separate leaves, sprays or blades,
# which the renderer composes into leaf-cluster and grass-clump cards.
FOLIAGE_ATLASES = {
    "beech": "LeafSet014",
    "oak": "LeafSet016",
    "linden": "LeafSet024",
    "fir": "LeafSet019",
    "grass": "Foliage001",
    "weeds": "Foliage007",
}
BARK_TEXTURES = {
    "broadleaf": "Bark012",
    "conifer": "Bark014",
}
VEGETATION_OUT = PUBLIC / "textures" / "vegetation"
ATLAS_SIZE = 1024
WEBP_QUALITY = "88"
# Sprites are found on a coarse copy of the opacity map: one cell per 8 px.
SPRITE_GRID = 128
SPRITE_OPACITY_THRESHOLD = 40
SPRITE_MIN_CELLS = 6
SPRITE_PADDING_PX = 6



def download(url: str, destination: Path) -> None:
    print(f"downloading {url}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request) as response:
        destination.write_bytes(response.read())


def download_bytes(url: str) -> bytes:
    print(f"downloading {url}")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request) as response:
        return response.read()


def srgb_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def decode_rgb(image: bytes, size: int) -> bytes:
    return subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", "pipe:0",
            "-vf", f"scale={size}:{size}:flags=lanczos",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ],
        input=image,
        check=True,
        capture_output=True,
    ).stdout


def encode_jpeg(rgb: bytes, size: int, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{size}x{size}", "-i", "pipe:0",
            "-q:v", JPEG_QUALITY, str(destination),
        ],
        input=rgb,
        check=True,
    )


def normalise_detail(rgb: bytes) -> bytes:
    """
    Linear colour divided by its per-channel mean and scaled to DETAIL_MEAN,
    stored as linear bytes. Brightness and hue variation are kept; the
    average colour is left to the renderer's surface colours.
    """
    to_linear = [srgb_to_linear(index / 255) for index in range(256)]
    pixel_count = len(rgb) // 3
    means = [sum(to_linear[value] for value in rgb[channel::3]) / pixel_count for channel in range(3)]
    tables = [
        bytes(min(255, round(to_linear[value] / means[channel] * DETAIL_MEAN * 255)) for value in range(256))
        for channel in range(3)
    ]
    out = bytearray(len(rgb))
    for channel in range(3):
        out[channel::3] = rgb[channel::3].translate(tables[channel])
    print("  mean linear colour " + ", ".join(f"{mean:.4f}" for mean in means))
    return bytes(out)


def fetch_terrain_textures() -> None:
    size = TERRAIN_TEXTURE_SIZE
    for layer, asset_id in TERRAIN_TEXTURES.items():
        archive = zipfile.ZipFile(io.BytesIO(download_bytes(f"https://ambientcg.com/get?file={asset_id}_1K-JPG.zip")))
        maps = {name.rsplit("_", 1)[-1]: name for name in archive.namelist()}
        print(f"{layer}: {asset_id}")
        detail = normalise_detail(decode_rgb(archive.read(maps["Color.jpg"]), size))
        encode_jpeg(detail, size, TERRAIN_OUT / f"{layer}_detail.jpg")
        normal = decode_rgb(archive.read(maps["NormalGL.jpg"]), size)
        encode_jpeg(normal, size, TERRAIN_OUT / f"{layer}_normal.jpg")


def decode_gray(image: bytes, size: int) -> bytes:
    return subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", "pipe:0",
            "-vf", f"scale={size}:{size}:flags=area",
            "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
        ],
        input=image,
        check=True,
        capture_output=True,
    ).stdout


def find_sprites(opacity: bytes) -> list[list[int]]:
    """Bounding boxes (x, y, w, h in atlas pixels) of the opaque islands."""
    grid = SPRITE_GRID
    coarse = decode_gray(opacity, grid)
    solid = [value > SPRITE_OPACITY_THRESHOLD for value in coarse]
    seen = [False] * (grid * grid)
    scale = ATLAS_SIZE // grid
    sprites = []
    for start in range(grid * grid):
        if not solid[start] or seen[start]:
            continue
        stack = [start]
        seen[start] = True
        cells = 0
        min_x = min_y = grid
        max_x = max_y = 0
        while stack:
            cell = stack.pop()
            cells += 1
            x, y = cell % grid, cell // grid
            min_x, max_x, min_y, max_y = min(min_x, x), max(max_x, x), min(min_y, y), max(max_y, y)
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < grid and 0 <= ny < grid:
                    neighbour = ny * grid + nx
                    if solid[neighbour] and not seen[neighbour]:
                        seen[neighbour] = True
                        stack.append(neighbour)
        if cells < SPRITE_MIN_CELLS:
            continue
        left = max(0, min_x * scale - SPRITE_PADDING_PX)
        top = max(0, min_y * scale - SPRITE_PADDING_PX)
        right = min(ATLAS_SIZE, (max_x + 1) * scale + SPRITE_PADDING_PX)
        bottom = min(ATLAS_SIZE, (max_y + 1) * scale + SPRITE_PADDING_PX)
        sprites.append([left, top, right - left, bottom - top])
    return sprites


def encode_rgba_webp(color: bytes, opacity: bytes, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as scratch:
        color_path = Path(scratch) / "color.jpg"
        opacity_path = Path(scratch) / "opacity.jpg"
        color_path.write_bytes(color)
        opacity_path.write_bytes(opacity)
        subprocess.run(
            [
                "ffmpeg", "-v", "error", "-y", "-i", str(color_path), "-i", str(opacity_path),
                "-filter_complex",
                f"[0]scale={ATLAS_SIZE}:{ATLAS_SIZE},format=rgba[c];"
                f"[1]scale={ATLAS_SIZE}:{ATLAS_SIZE},format=gray[a];[c][a]alphamerge",
                "-c:v", "libwebp", "-quality", WEBP_QUALITY, "-frames:v", "1", str(destination),
            ],
            check=True,
        )


def resize_jpeg(image: bytes, size: int, destination: Path) -> None:
    encode_jpeg(decode_rgb(image, size), size, destination)


def fetch_vegetation_textures() -> None:
    manifest = {}
    for name, asset_id in FOLIAGE_ATLASES.items():
        archive = zipfile.ZipFile(io.BytesIO(download_bytes(f"https://ambientcg.com/get?file={asset_id}_1K-JPG.zip")))
        maps = {entry.rsplit("_", 1)[-1]: entry for entry in archive.namelist()}
        color, opacity = archive.read(maps["Color.jpg"]), archive.read(maps["Opacity.jpg"])
        encode_rgba_webp(color, opacity, VEGETATION_OUT / f"{name}.webp")
        manifest[name] = {"size": ATLAS_SIZE, "sprites": find_sprites(opacity)}
        print(f"{name}: {asset_id}, {len(manifest[name]['sprites'])} sprites")
    (VEGETATION_OUT / "atlases.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    for name, asset_id in BARK_TEXTURES.items():
        archive = zipfile.ZipFile(io.BytesIO(download_bytes(f"https://ambientcg.com/get?file={asset_id}_1K-JPG.zip")))
        maps = {entry.rsplit("_", 1)[-1]: entry for entry in archive.namelist()}
        resize_jpeg(archive.read(maps["Color.jpg"]), ATLAS_SIZE, VEGETATION_OUT / f"bark_{name}_color.jpg")
        resize_jpeg(archive.read(maps["NormalGL.jpg"]), ATLAS_SIZE, VEGETATION_OUT / f"bark_{name}_normal.jpg")
        print(f"bark {name}: {asset_id}")


def fetch_hdri(destination: Path) -> None:
    url = (
        "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/"
        f"{HDRI_RESOLUTION}/{HDRI_ID}_{HDRI_RESOLUTION}.hdr"
    )
    download(url, destination)


def probe_size(hdr_path: Path) -> tuple[int, int]:
    output = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0", str(hdr_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    width, height = (int(value) for value in output.strip().split(","))
    return width, height


Panorama = tuple[int, int, list[float], list[float], list[float]]


def read_panorama(hdr_path: Path) -> Panorama:
    """Decode an HDR panorama to linear float RGB planes, top row first."""
    # Full resolution on purpose: ffmpeg's scaler clamps float pixels to 1.0,
    # which would flatten the sun into the sky around it.
    width, height = probe_size(hdr_path)
    raw = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", str(hdr_path),
            "-f", "rawvideo", "-pix_fmt", "gbrpf32le", "-",
        ],
        check=True,
        capture_output=True,
    ).stdout
    plane = width * height
    values = struct.unpack(f"<{plane * 3}f", raw)
    green, blue, red = values[:plane], values[plane:plane * 2], values[plane * 2:]
    return width, height, list(red), list(green), list(blue)


def luminance(red: float, green: float, blue: float) -> float:
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def report_sun(panorama: Panorama) -> None:
    """
    Print the direction toward the brightest point of the panorama in the
    Babylon world frame, using the same equirectangular mapping as Babylon's
    PanoramaToCubeMapTools: u = atan2(z, x) / (2 pi) + 0.5, v = acos(y) / pi.
    """
    width, height, red, green, blue = panorama
    best_index = max(range(width * height), key=lambda i: luminance(red[i], green[i], blue[i]))
    u = (best_index % width + 0.5) / width
    v = (best_index // width + 0.5) / height
    theta = (u - 0.5) * 2 * math.pi
    phi = v * math.pi
    y = math.cos(phi)
    peak = luminance(red[best_index], green[best_index], blue[best_index])
    print(f"sun at u={u:.4f} v={v:.4f}, peak luminance {peak:.0f}")
    print(f"sun elevation {math.degrees(math.asin(y)):.1f} deg, azimuth atan2(z, x) {math.degrees(theta):.1f} deg")


def report_horizon(panorama: Panorama) -> None:
    width, height, red, green, blue = panorama
    first, last = (int(fraction * height) for fraction in HORIZON_BAND)
    indices = range(first * width, last * width)
    count = len(indices)
    mean = [sum(channel[i] for i in indices) / count for channel in (red, green, blue)]
    print("horizon colour (linear): " + ", ".join(f"{value:.4f}" for value in mean))


def cap_sun(panorama: Panorama) -> int:
    """Scale every pixel brighter than SUN_LUMINANCE_CAP down to it, in place."""
    width, height, red, green, blue = panorama
    capped = 0
    for i in range(width * height):
        value = luminance(red[i], green[i], blue[i])
        if value > SUN_LUMINANCE_CAP:
            scale = SUN_LUMINANCE_CAP / value
            red[i] *= scale
            green[i] *= scale
            blue[i] *= scale
            capped += 1
    return capped


def to_rgbe(red: float, green: float, blue: float) -> tuple[int, int, int, int]:
    brightest = max(red, green, blue)
    if brightest < 1e-32:
        return 0, 0, 0, 0
    mantissa, exponent = math.frexp(brightest)
    scale = mantissa * 256.0 / brightest
    return int(red * scale), int(green * scale), int(blue * scale), exponent + 128


def rle_channel(values: bytes) -> bytearray:
    """Radiance new-style run-length encoding of one scanline channel."""
    out = bytearray()
    index = 0
    length = len(values)
    while index < length:
        run = 1
        while index + run < length and run < 127 and values[index + run] == values[index]:
            run += 1
        if run >= 4:
            out += bytes((128 + run, values[index]))
            index += run
            continue
        start = index
        while index < length and index - start < 128:
            ahead = values[index:index + 4]
            if len(ahead) == 4 and ahead.count(ahead[0]) == 4:
                break
            index += 1
        out.append(index - start)
        out += values[start:index]
    return out


def write_panorama(panorama: Panorama, destination: Path) -> None:
    width, height, red, green, blue = panorama
    out = bytearray(f"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y {height} +X {width}\n".encode("ascii"))
    for row in range(height):
        pixels = [to_rgbe(red[i], green[i], blue[i]) for i in range(row * width, (row + 1) * width)]
        out += bytes((2, 2, width >> 8, width & 0xFF))
        for channel in range(4):
            out += rle_channel(bytes(pixel[channel] for pixel in pixels))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(out)


def main() -> int:
    only = set(sys.argv[1:])
    if not only or "vegetation" in only:
        fetch_vegetation_textures()
    if only:
        return 0
    fetch_terrain_textures()
    with tempfile.TemporaryDirectory() as scratch:
        source = Path(scratch) / "source.hdr"
        fetch_hdri(source)
        panorama = read_panorama(source)
    report_sun(panorama)
    report_horizon(panorama)
    print(f"capped {cap_sun(panorama)} sun pixels at luminance {SUN_LUMINANCE_CAP}")
    write_panorama(panorama, HDRI_OUT)
    print(f"wrote {HDRI_OUT.relative_to(ROOT)} ({HDRI_OUT.stat().st_size // 1024} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
