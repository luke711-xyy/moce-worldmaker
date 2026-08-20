"""Generate canonical non-cubic voxel brush assets for offline inspection.

The editor keeps the runtime meshes in TypeScript so loading a brush never
depends on Blender. This script is the authoring/validation companion: run it
with Blender's Python to create GLB previews and a manifest for review.
Coordinates are one unit per voxel cell; the canonical attachment normal is
local +Z and the editor applies facing/quarter-turn transforms at runtime.
"""
import bpy
import json
import math
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "public" / "voxel-shapes"

def clear():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

def mesh_object(name, vertices, faces):
    mesh = bpy.data.meshes.new(f"{name}-mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def tri_prism(name):
    # Half-cell right triangular prism.  The canonical attachment direction
    # is local +Z; the runtime applies the six facings and quarter turns.
    vertices = [
        (0, 0, 0), (1, 0, 0), (1, 0, 1),
        (0, 1, 0), (1, 1, 0), (1, 1, 1),
    ]
    faces = [
        (0, 1, 4, 3),       # bottom
        (1, 2, 5, 4),       # sloped side
        (0, 3, 5, 2),       # vertical side
        (0, 2, 1),          # end cap
        (3, 4, 5),          # end cap
    ]
    return mesh_object(name, vertices, faces)


def quarter_cylinder(name, segments=16):
    # A quarter of a unit-radius cylinder extruded through one cell.  The
    # center is at the local origin and the arc occupies the first quadrant.
    vertices = [(0, 0, 0), (0, 0, 1)]
    for index in range(segments + 1):
        angle = (math.pi / 2) * index / segments
        x, y = math.cos(angle), math.sin(angle)
        vertices.extend([(x, y, 0), (x, y, 1)])
    faces = []
    for index in range(segments):
        a0 = 2 + index * 2
        a1 = a0 + 2
        faces.append((a0, a1, a1 + 1, a0 + 1))
        faces.append((0, a1, a0))
        faces.append((1, a0 + 1, a1 + 1))
    first_bottom, first_top = 2, 3
    last_bottom, last_top = 2 + segments * 2, 3 + segments * 2
    faces.append((0, first_bottom, first_top, 1))
    faces.append((0, 1, last_top, last_bottom))
    return mesh_object(name, vertices, faces)


def stair(name):
    # Two exposed boxes: lower half is full, upper half is half width.
    vertices, faces = [], []
    def box(minimum, maximum):
        x0, y0, z0 = minimum
        x1, y1, z1 = maximum
        base = len(vertices)
        vertices.extend([
            (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
        ])
        faces.extend([
            (base + 0, base + 1, base + 2, base + 3),
            (base + 4, base + 7, base + 6, base + 5),
            (base + 0, base + 4, base + 5, base + 1),
            (base + 1, base + 5, base + 6, base + 2),
            (base + 2, base + 6, base + 7, base + 3),
            (base + 4, base + 0, base + 3, base + 7),
        ])
    box((0, 0, 0), (1, 0.5, 1))
    box((0, 0.5, 0), (0.5, 1, 1))
    return mesh_object(name, vertices, faces)

def make_shapes():
    return [
        tri_prism("tri-prism"),
        quarter_cylinder("quarter-cylinder"),
        stair("stair"),
    ]

def main():
    clear()
    OUT.mkdir(parents=True, exist_ok=True)
    objects = make_shapes()
    for obj in objects:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.export_scene.gltf(filepath=str(OUT / f"{obj.name}.glb"), export_format='GLB', use_selection=True)
        obj.select_set(False)
    (OUT / "manifest.json").write_text(json.dumps({
        "cell": 1,
        "canonicalFacing": "+z",
        "shapes": ["tri-prism", "quarter-cylinder", "stair"],
        "volumeRatios": {"tri-prism": 0.5, "quarter-cylinder": math.pi / 4, "stair": 0.75},
        "note": "Runtime geometry is authoritative; GLB files are review assets."
    }, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main()
