#!/usr/bin/env python3
"""
convert-logo.py — Convert logo image to thermal printer format
═══════════════════════════════════════════════════════════════
Converts any image to monochrome 1-bit PNG suitable for
receiptline's {i:base64} image property.

Outputs:
  logo-sm.png       — 200px wide, black on white (line art)
  logo-inv.png      — 200px wide, white on black (dramatic)
  logo-sm-b64.txt   — Base64 of line art version
  logo-inv-b64.txt  — Base64 of inverted version

Usage:
  python3 convert-logo.py <input-image> [--width 200] [--threshold 110]
"""

import sys
import base64
import io
from PIL import Image, ImageEnhance, ImageOps

def convert_logo(input_path, width=200, threshold=110):
    img = Image.open(input_path)
    print(f"Input: {input_path} ({img.size[0]}x{img.size[1]}, {img.mode})")

    gray = img.convert('L')

    # Detect if logo is light-on-dark or dark-on-light
    # by checking average brightness of border vs center
    w, h = gray.size
    border_avg = sum(gray.getpixel((x, 0)) for x in range(w)) / w
    center_avg = sum(gray.getpixel((w//2, y)) for y in range(h//4, 3*h//4)) / (h//2)
    
    is_light_on_dark = center_avg > border_avg
    print(f"Detected: {'light on dark' if is_light_on_dark else 'dark on light'}")

    # For LINE ART (black logo on white paper):
    if is_light_on_dark:
        inverted = ImageOps.invert(gray)
    else:
        inverted = gray

    # Resize
    ratio = width / inverted.width
    height = int(inverted.height * ratio)

    # Line art version
    sm = inverted.resize((width, height), Image.LANCZOS)
    sm = ImageEnhance.Contrast(sm).enhance(2.5)
    mono_sm = sm.point(lambda x: 255 if x > threshold else 0, '1')
    mono_sm.save('logo-sm.png')
    
    buf = io.BytesIO()
    mono_sm.save(buf, format='PNG')
    b64_sm = base64.b64encode(buf.getvalue()).decode('ascii')
    with open('logo-sm-b64.txt', 'w') as f:
        f.write(b64_sm)

    # Inverted version (white on black)
    if is_light_on_dark:
        noninv = gray.resize((width, height), Image.LANCZOS)
    else:
        noninv = ImageOps.invert(gray).resize((width, height), Image.LANCZOS)
    
    noninv = ImageEnhance.Contrast(noninv).enhance(2.5)
    mono_inv = noninv.point(lambda x: 255 if x > (255 - threshold) else 0, '1')
    mono_inv.save('logo-inv.png')

    buf2 = io.BytesIO()
    mono_inv.save(buf2, format='PNG')
    b64_inv = base64.b64encode(buf2.getvalue()).decode('ascii')
    with open('logo-inv-b64.txt', 'w') as f:
        f.write(b64_inv)

    print(f"\nOutputs:")
    print(f"  logo-sm.png      ({width}x{height}px, line art)")
    print(f"  logo-inv.png     ({width}x{height}px, inverted)")
    print(f"  logo-sm-b64.txt  ({len(b64_sm)} chars)")
    print(f"  logo-inv-b64.txt ({len(b64_inv)} chars)")
    print(f"\nUsage in receiptline:")
    print(f'  {{i:<contents of logo-sm-b64.txt>}}')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 convert-logo.py <image> [--width 200] [--threshold 110]")
        sys.exit(1)
    
    input_path = sys.argv[1]
    width = 200
    threshold = 110
    
    for i, arg in enumerate(sys.argv):
        if arg == '--width' and i + 1 < len(sys.argv):
            width = int(sys.argv[i + 1])
        if arg == '--threshold' and i + 1 < len(sys.argv):
            threshold = int(sys.argv[i + 1])
    
    convert_logo(input_path, width, threshold)
