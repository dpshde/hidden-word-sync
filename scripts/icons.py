#!/usr/bin/env python3
"""Regenerates every Selah Vault icon from one glyph definition.

Matches route.bible's tile: 100-unit tile, corner radius 22, glyph's tallest side = 56% of the tile
(22% inset top and bottom), centred. Run: python3 scripts/icons.py  (needs cairosvg + Pillow).
"""
import io
from pathlib import Path

import cairosvg
from PIL import Image

PUB = Path(__file__).resolve().parent.parent / "public"
CREAM, DARK_TILE, INK, OCHRE = "#F3EFE5", "#E6DFD0", "#4D3C22", "#C9A24E"
RADIUS = 22
GLYPH_H = 65.38  # glyph's authored height, -32.69..32.69
SCALE = round(56 / GLYPH_H, 4)
PATHS = [
    ("M-18.662 -32.69H-6.25V-18.19H-20.75V-30.602Q-20.75 -32.69 -18.662 -32.69Z", OCHRE),
    ("M6.25 -32.69H18.662Q20.75 -32.69 20.75 -30.602V-18.19H6.25Z", OCHRE),
    ("M-20.75 -5.69L-6.25 -5.69L-6.25 23.7L-20.75 32.69Z", INK),
    ("M6.25 -5.69L20.75 -5.69L20.75 32.69L6.25 23.7Z", INK),
]


def svg(rx=RADIUS, css=True):
    glyph = "".join(f'<path d="{d}" fill="{c}"/>' for d, c in PATHS)
    style = f"<style>.tile{{fill:{CREAM}}}@media (prefers-color-scheme: dark){{.tile{{fill:{DARK_TILE}}}}}</style>" if css else ""
    fill = "" if css else f' fill="{CREAM}"'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">{style}'
            f'<rect class="tile" width="100" height="100" rx="{rx}"{fill}/>'
            f'<g transform="translate(50 50) scale({SCALE})">{glyph}</g></svg>\n')


def png(src, size):
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=src.encode(), output_width=size, output_height=size))).convert("RGBA")


(PUB / "favicon.svg").write_text(svg())
rounded, square = svg(css=False), svg(rx=0, css=False)
for name, size in (("icon-192.png", 192), ("icon-512.png", 512)):
    png(rounded, size).save(PUB / name)
png(square, 180).convert("RGB").save(PUB / "apple-touch-icon.png")  # iOS rounds it; no transparency
# Maskable: full bleed. The glyph's corners sit ~33% from centre, inside the 40% safe-zone circle.
png(square, 512).convert("RGB").save(PUB / "icon-maskable-512.png")
png(rounded, 256).save(PUB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
print("icons written, scale", SCALE)
