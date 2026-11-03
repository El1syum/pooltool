"""Prepare local review-only, untextured derivatives from a user-supplied OBJ pack.

No source bytes are committed or published by this script. Rights must be
confirmed separately before distributing the generated GLBs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from audit_pack import read_obj


def write_glb(path, positions, normals, triangles, groups, materials, metadata):
    blocks, views, accessors = [], [], []
    length = 0

    def accessor(array, component_type, kind, target, bounds=False):
        nonlocal length
        data = np.ascontiguousarray(array).tobytes()
        padded = data + b"\0" * (-len(data) % 4)
        views.append({"buffer": 0, "byteOffset": length, "byteLength": len(data), "target": target})
        entry = {"bufferView": len(views)-1, "componentType": component_type,
                 "count": len(array), "type": kind}
        if bounds:
            entry.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        accessors.append(entry)
        blocks.append(padded)
        length += len(padded)
        return len(accessors)-1

    position_accessor = accessor(positions.astype("<f4"), 5126, "VEC3", 34962, True)
    normal_accessor = accessor(normals.astype("<f4"), 5126, "VEC3", 34962)
    primitives = []
    for index in range(len(materials)):
        selected = triangles[groups == index].reshape(-1)
        if not len(selected): continue
        indices = accessor(selected.astype("<u4"), 5125, "SCALAR", 34963)
        primitives.append({"attributes": {"POSITION": position_accessor, "NORMAL": normal_accessor},
                           "indices": indices, "material": index})
    document = {"asset": {"version": "2.0", "generator": "Pooltool local asset preparation"},
                "scene": 0, "scenes": [{"nodes": [0]}],
                "nodes": [{"name": metadata["name"], "mesh": 0}],
                "meshes": [{"name": metadata["name"], "primitives": primitives}],
                "materials": materials, "buffers": [{"byteLength": length}],
                "bufferViews": views, "accessors": accessors, "extras": metadata}
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary = b"".join(blocks)
    total = 12 + 8 + len(encoded) + 8 + len(binary)
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<II", len(encoded), 0x4E4F534A)
                     + encoded + struct.pack("<II", len(binary), 0x004E4942) + binary)


def material(name, color, roughness=.7, metalness=0):
    # glTF baseColorFactor values are linear, converted from a chosen sRGB tint.
    rgb = np.array([int(color[i:i+2], 16) / 255 for i in (1, 3, 5)])
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055)**2.4)
    return {"name": name, "doubleSided": True,
            "pbrMetallicRoughness": {"baseColorFactor": [*linear.tolist(), 1],
                                     "roughnessFactor": roughness, "metallicFactor": metalness}}


def prepare(source: Path, output: Path, table_number: int):
    original, triangles, original_normals, *_ = read_obj(source)
    raw_triangles = original[triangles]
    cross = np.cross(raw_triangles[:,1]-raw_triangles[:,0], raw_triangles[:,2]-raw_triangles[:,0])
    triangles = triangles[np.linalg.norm(cross, axis=1) > 1e-9]
    center = (original.min(axis=0) + original.max(axis=0)) / 2
    # Measured cushion nose, not the outside cabinet or a guessed 2:1 rectangle.
    nose_vertices = original[np.abs(original[:,1] - 78.76524353) < .02]
    nose_min, nose_max = nose_vertices.min(axis=0), nose_vertices.max(axis=0)
    nose_center = (nose_min + nose_max) / 2
    cloth = 76.78940582 if table_number < 4 else 76.78694916
    width, length, height = .9906, 1.9812, .708
    scale = np.array([length/(nose_max[0]-nose_min[0]), height/cloth,
                      width/(nose_max[2]-nose_min[2])])
    positions = (original - [nose_center[0], cloth, nose_center[2]]) * scale
    positions = positions[:, [2,1,0]] * [1,1,-1]
    normals = np.asarray(original_normals) / scale
    normals = normals[:,[2,1,0]] * [1,1,-1]
    normals /= np.maximum(np.linalg.norm(normals,axis=1,keepdims=True),1e-15)
    triangle_vertices = original[triangles]
    centroid = triangle_vertices.mean(axis=1)
    groups = np.zeros(len(triangles), dtype=np.int32)
    # The ripped OBJ has no material groups: explicitly reconstructed simple PBR
    # tints, not recovered original textures or claims about original materials.
    green = (triangle_vertices[:,:,1].min(axis=1) >= cloth-.02) & (triangle_vertices[:,:,1].max(axis=1) <= 79.35)
    groups[green] = 1
    # Separate actual disconnected pocket fittings from the cabinet's top rail.
    welded, inverse = np.unique(np.round(original, 3), axis=0, return_inverse=True)
    welded_faces = inverse[triangles]
    edges = np.concatenate([welded_faces[:,[0,1]], welded_faces[:,[1,2]], welded_faces[:,[2,0]]])
    graph = coo_matrix((np.ones(len(edges)),(edges[:,0],edges[:,1])),shape=(len(welded),len(welded)))
    _, labels = connected_components(graph,directed=False)
    face_labels = labels[welded_faces[:,0]]
    metal = np.zeros(len(triangles),dtype=bool)
    for component in np.unique(face_labels):
        selected = face_labels == component
        points = triangle_vertices[selected].reshape(-1,3)
        if points[:,1].min()>79.6 and points[:,1].max()>80.6:
            metal[selected] = True
    groups[metal] = 2
    groups[centroid[:,1] < 3.3] = 3
    # Pocket liners below cloth are dark; retain the original openings for review.
    long_offset = np.abs(centroid[:,0]-nose_center[0])
    short_offset = np.abs(centroid[:,2]-nose_center[2])
    liner = (centroid[:,1] < cloth) & (centroid[:,1] > 64) & (short_offset > 63) & ((long_offset > 120) | (long_offset < 9))
    groups[liner] = 3
    palette = [material("Cabinet · walnut tint", "#4d3022", .5),
               material("Cloth and cushions · teal", "#147960", .92),
               material("Pocket fittings · brass", "#ac915a", .28, .7),
               material("Pocket liners and feet", "#151b18", .95)]
    metadata = {"name": f"Pack table {table_number} · local review",
                "previewOnly": True, "rights": "Unverified user-supplied Sketchfab rip; do not redistribute",
                "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "triangles": len(triangles), "removedDegenerateTriangles": len(raw_triangles)-len(triangles),
                "calibration": {"clothY": 0, "targetWidth": width, "targetLength": length,
                                "targetClothHeight": height, "sourceNoseMin": nose_min.tolist(),
                                "sourceNoseMax": nose_max.tolist(), "sourceScaleXYZ": scale.tolist()},
                "knownIssue": "Original pocket openings retained; do not publish before matching physical capture holes"}
    output.mkdir(parents=True, exist_ok=True)
    target = output / f"pack-table-{table_number}-review.glb"
    write_glb(target, positions, normals, triangles, groups, palette, metadata)
    return {"file": target.name, "bytes": target.stat().st_size,
            "triangles": len(triangles), "metadata": metadata}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("source",type=Path)
    parser.add_argument("output",type=Path)
    args=parser.parse_args()
    reports=[]
    for index, source in enumerate(sorted(args.source.glob("PoolTable*.obj")), 1):
        reports.append(prepare(source,args.output,index))
    (args.output/"preparation.json").write_text(json.dumps(reports,indent=2),encoding="utf-8")
    for item in reports: print(item["file"], item["bytes"], "bytes", item["triangles"], "triangles")


if __name__ == "__main__": main()
