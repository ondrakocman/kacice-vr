#!/usr/bin/env python3
"""Equirect panorama -> 6 cubemap faces (OpenGL cube-map convention, as used by
XR_KHR_composition_layer_cube / WebXR createCubeLayer).

Face order and mapping follow the GL spec table: for direction (rx, ry, rz)
  +X: s=-rz t=-ry | -X: s=+rz t=-ry | +Y: s=+rx t=+rz | -Y: s=+rx t=-rz | +Z: s=+rx t=-ry | -Z: s=-rx t=-ry
Face image row 0 == t=0 (uploaded with UNPACK_FLIP_Y_WEBGL = false).
Equirect convention (matches WebXR equirect layers): image centre == -Z (forward), +X == right, +Y == up.

usage: gen_cube.py <equirect> <outdir> <prefix> <size> [quality]
       writes <outdir>/<prefix>-{px,nx,py,ny,pz,nz}.webp
"""
import sys, os, numpy as np, cv2
from PIL import Image
Image.MAX_IMAGE_PIXELS = None

FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz']

def face_dirs(face, n):
    # pixel centres in [-1, 1]; a = 2s-1 (columns), b = 2t-1 (rows, row 0 == t=0)
    a = (np.arange(n) + 0.5) / n * 2 - 1
    A, B = np.meshgrid(a, a)          # A varies along columns (s), B along rows (t)
    one = np.ones_like(A)
    if face == 'px': rx, ry, rz =  one, -B, -A
    if face == 'nx': rx, ry, rz = -one, -B,  A
    if face == 'py': rx, ry, rz =  A,  one,  B
    if face == 'ny': rx, ry, rz =  A, -one, -B
    if face == 'pz': rx, ry, rz =  A, -B,  one
    if face == 'nz': rx, ry, rz = -A, -B, -one
    return rx, ry, rz

def dirs_to_uv(rx, ry, rz, w, h):
    lon = np.arctan2(rx, -rz)                         # -Z -> 0, +X -> +90deg
    lat = np.arcsin(ry / np.sqrt(rx*rx + ry*ry + rz*rz))
    u = (0.5 + lon / (2*np.pi)) * w - 0.5             # pixel coords (centre-based)
    v = (0.5 - lat / np.pi) * h - 0.5
    return u.astype(np.float32), v.astype(np.float32)

def main():
    src, outdir, prefix, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    q = int(sys.argv[5]) if len(sys.argv) > 5 else 88
    img = np.asarray(Image.open(src).convert('RGB'))
    h, w, _ = img.shape
    # pad one column on each side so the wrap edge interpolates across the seam
    padded = np.concatenate([img[:, -1:], img, img[:, :1]], axis=1)
    os.makedirs(outdir, exist_ok=True)
    for face in FACES:
        rx, ry, rz = face_dirs(face, n)
        u, v = dirs_to_uv(rx, ry, rz, w, h)
        u = np.mod(u, w) + 1.0                        # shift into padded coordinates
        v = np.clip(v, 0, h - 1)
        out = cv2.remap(padded, u, v, interpolation=cv2.INTER_AREA if n < w/4 else cv2.INTER_CUBIC,
                        borderMode=cv2.BORDER_WRAP)
        Image.fromarray(out).save(os.path.join(outdir, f'{prefix}-{face}.webp'), quality=q, method=4)
    print('ok', prefix, n)

if __name__ == '__main__':
    main()
