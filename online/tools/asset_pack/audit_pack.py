"""Read-only source ZIP inspection; derivatives stay in the ignored intake area."""
from __future__ import annotations

import argparse
import binascii
import json
from pathlib import Path
import stat
import zipfile

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components


def read_obj(path: Path):
    vertices, normals, uv, faces = [], [], [], []
    groups, materials, libraries = {}, {}, []
    current_group, current_material = "default", "none"
    with path.open(encoding="utf-8", errors="replace") as stream:
        for line in stream:
            parts = line.split()
            if not parts:
                continue
            if parts[0] == "v": vertices.append([float(value) for value in parts[1:4]])
            elif parts[0] == "vn": normals.append([float(value) for value in parts[1:4]])
            elif parts[0] == "vt": uv.append([float(value) for value in parts[1:3]])
            elif parts[0] in ("o", "g"): current_group = " ".join(parts[1:])
            elif parts[0] == "usemtl": current_material = " ".join(parts[1:])
            elif parts[0] == "mtllib": libraries.extend(parts[1:])
            elif parts[0] == "f":
                polygon = [int(value.split("/")[0]) for value in parts[1:]]
                polygon = [value - 1 if value > 0 else len(vertices) + value for value in polygon]
                for i in range(1, len(polygon) - 1):
                    faces.append([polygon[0], polygon[i], polygon[i + 1]])
                    groups[current_group] = groups.get(current_group, 0) + 1
                    materials[current_material] = materials.get(current_material, 0) + 1
    return np.asarray(vertices), np.asarray(faces), normals, uv, groups, materials, libraries


def audit(path: Path):
    vertices, faces, normals, uv, groups, materials, libraries = read_obj(path)
    triangle = vertices[faces]
    cross = np.cross(triangle[:, 1] - triangle[:, 0], triangle[:, 2] - triangle[:, 0])
    area = np.linalg.norm(cross, axis=1) / 2
    centroids = triangle.mean(axis=1)
    normal = cross / np.maximum(2 * area[:, None], 1e-15)
    welded, inverse = np.unique(np.round(vertices, 3), axis=0, return_inverse=True)
    valid_faces = faces[area > 1e-12]
    welded_faces = inverse[valid_faces]
    edges = np.concatenate([welded_faces[:, [0, 1]], welded_faces[:, [1, 2]], welded_faces[:, [2, 0]]])
    graph = coo_matrix((np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(len(welded), len(welded)))
    _, component = connected_components(graph, directed=False)
    face_component = component[welded_faces[:, 0]]
    components = []
    for label in np.unique(face_component):
        sample = vertices[valid_faces[face_component == label]].reshape(-1, 3)
        components.append({"triangles": int(np.count_nonzero(face_component == label)),
                           "min": sample.min(axis=0).tolist(), "max": sample.max(axis=0).tolist()})
    components.sort(key=lambda value: value["triangles"], reverse=True)
    levels = []
    for axis in range(3):
        aligned = np.abs(normal[:, axis]) > .999
        rounded = np.round(centroids[aligned, axis], 4)
        values, inverse = np.unique(rounded, return_inverse=True)
        weighted = np.bincount(inverse, weights=area[aligned])
        levels.append([{ "level": float(values[index]), "area": float(weighted[index]),
                        "triangleCount": int(np.count_nonzero(inverse == index)) }
                       for index in np.argsort(weighted)[-12:][::-1]])
    return {"file": path.name, "bytes": path.stat().st_size,
            "vertices": len(vertices), "triangles": len(faces), "normals": len(normals),
            "uv": len(uv), "groups": groups, "materials": materials, "mtllib": libraries,
            "bounds": {"min": vertices.min(axis=0).tolist(), "max": vertices.max(axis=0).tolist(),
                       "size": np.ptp(vertices, axis=0).tolist()},
            "degenerateTriangles": int(np.count_nonzero(area < 1e-12)), "areaLevelsByAxis": levels,
            "components": components}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    extracted = output / "source"
    extracted.mkdir(exist_ok=True)
    entries = []
    with zipfile.ZipFile(args.archive) as archive:
        if len(archive.infolist()) > 1000 or sum(info.file_size for info in archive.infolist()) > 256 * 1024 * 1024:
            raise ValueError("Archive exceeds the local intake budget")
        for info in archive.infolist():
            destination = (extracted / info.filename).resolve()
            if not destination.is_relative_to(extracted.resolve()) or stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError("Unsafe ZIP entry")
            if info.file_size > 100_000_000:
                raise ValueError("Unexpectedly large ZIP entry")
            entries.append({"name": info.filename, "bytes": info.file_size})
            if destination.exists() and not info.is_dir():
                if destination.stat().st_size != info.file_size or binascii.crc32(destination.read_bytes()) != info.CRC:
                    raise ValueError("Existing intake source differs; refusing to overwrite it")
            elif not destination.exists():
                archive.extract(info, extracted)
    reports = [audit(path) for path in sorted(extracted.glob("PoolTable*.obj"))]
    result = {"archive": args.archive.name, "entries": entries, "tables": reports}
    (output / "audit.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    for report in reports:
        print(json.dumps({key: report[key] for key in ["file", "vertices", "triangles", "bounds", "materials", "mtllib", "degenerateTriangles"]}))


if __name__ == "__main__": main()
