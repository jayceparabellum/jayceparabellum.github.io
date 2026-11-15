"""Prepare a photo for the website: fix rotation, resize, strip ALL metadata (GPS!), save as JPEG.

iPhone photos carry GPS coordinates in EXIF. This script re-encodes pixels only, so nothing
but the image itself is published.

Usage:
    pip install pillow pillow-heif
    python tools/add-photo.py "C:/path/IMG_1234.HEIC" images/new-name.jpg [--max 1600]
"""
import argparse
from PIL import Image, ImageOps

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:  # HEIC support is optional
    pass

p = argparse.ArgumentParser()
p.add_argument("src")
p.add_argument("dest")
p.add_argument("--max", type=int, default=1600, help="longest edge in pixels")
a = p.parse_args()

im = ImageOps.exif_transpose(Image.open(a.src)).convert("RGB")
im.thumbnail((a.max, a.max), Image.LANCZOS)
clean = Image.new("RGB", im.size)
clean.paste(im)  # copy pixels only; no EXIF/XMP/ICC carried over
clean.save(a.dest, "JPEG", quality=84, optimize=True, progressive=True)
print(f"{a.dest}: {clean.size[0]}x{clean.size[1]}, metadata stripped")
