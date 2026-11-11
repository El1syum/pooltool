/** Closed cosmetic cushion rails fitted to the unchanged engine contact paths. */
import {renderPoint as point} from './table_coordinates.mjs';
const EPS = 1e-7;
const NOSE_RADIUS = .005;
const BASE_Y = .004;
const TOP_Y = .054;

const distance = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const same = (a, b) => distance(a, b) < EPS;
const shortest = angle => ((angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

/** Six ordered jaw-to-jaw paths. Each includes two bevels, two arcs and one main line. */
export function buildCushionPaths(reference) {
  const lines = reference.linear.map(line => ({ id: String(line.id), a: point(line.p1, reference), b: point(line.p2, reference) }));
  const mains = lines.filter(line => Math.abs(line.a[0] - line.b[0]) < EPS || Math.abs(line.a[2] - line.b[2]) < EPS);
  if (mains.length !== 6) throw Error(`Expected six axis-aligned main cushions, received ${mains.length}`);
  const arcs = reference.circular.map(arc => {
    const center = point(arc.center, reference), tangents = [];
    for (const line of lines) for (const p of [line.a, line.b]) {
      if (Math.abs(distance(p, center) - arc.radius) < EPS && !tangents.some(q => same(p, q))) tangents.push(p);
    }
    if (tangents.length !== 2) throw Error(`Expected two exact tangent points for jaw ${arc.id}`);
    return { id: String(arc.id), center, radius: arc.radius, tangents };
  });

  const rails = mains.map(main => {
    const along = Math.abs(main.a[0] - main.b[0]) < EPS ? 2 : 0;
    const across = along === 2 ? 0 : 2;
    const sign = Math.sign((main.a[across] + main.b[across]) / 2);
    const half = across === 0 ? reference.width / 2 : reference.length / 2;
    const back = sign * (half + .06);
    const endpoints = [main.a, main.b].sort((a, b) => a[along] - b[along]);
    const usedLines = [main.id], usedArcs = [];

    const extension = start => {
      const arc = arcs.find(candidate => candidate.tangents.some(p => same(p, start)));
      if (!arc) throw Error(`No rounded jaw meets main cushion ${main.id}`);
      const end = arc.tangents.find(p => !same(p, start));
      const bevel = lines.find(line => line !== main && (same(line.a, end) || same(line.b, end)));
      if (!bevel) throw Error(`No pocket bevel meets rounded jaw ${arc.id}`);
      const outer = same(bevel.a, end) ? bevel.b : bevel.a;
      const angle = Math.atan2(start[2] - arc.center[2], start[0] - arc.center[0]);
      const delta = shortest(Math.atan2(end[2] - arc.center[2], end[0] - arc.center[0]) - angle);
      const steps = Math.max(12, Math.ceil(Math.abs(delta) / (Math.PI / 96)));
      const result = [{ point: [...start], source: 'arc', id: arc.id }];
      for (let i = 1; i <= steps; i++) {
        const a = angle + delta * i / steps;
        result.push({ point: i === steps ? [...end] : [arc.center[0] + Math.cos(a) * arc.radius, arc.center[1], arc.center[2] + Math.sin(a) * arc.radius], source: 'arc', id: arc.id });
      }
      result.push({ point: [...outer], source: 'bevel', id: bevel.id });
      usedLines.push(bevel.id); usedArcs.push(arc.id);
      return result;
    };

    const low = extension(endpoints[0]).reverse();
    const high = extension(endpoints[1]);
    const path = [...low, { point: [...endpoints[1]], source: 'main', id: main.id }, ...high.slice(1)];
    for (let i = 1; i < path.length; i++) {
      if (path[i].point[along] - path[i - 1].point[along] <= 1e-10) throw Error(`Non-monotonic rail path ${main.id}`);
    }
    for (const entry of path) {
      const width = sign * (back - entry.point[across]);
      if (!(width > .001)) throw Error(`Back plane intersects cushion ${main.id}`);
    }
    return { id: main.id, along, across, sign, back, path, lineIds: usedLines, arcIds: usedArcs };
  });
  if (new Set(rails.flatMap(rail => rail.lineIds)).size !== reference.linear.length
    || new Set(rails.flatMap(rail => rail.arcIds)).size !== reference.circular.length) {
    throw Error('Every engine cushion segment must belong to exactly one closed rail');
  }
  return rails;
}

function section(width, noseY) {
  // The round centre lies behind the physical contact line: no visual tube
  // protrudes another 5 mm into the field or across a pocket throat.
  const radius = Math.min(NOSE_RADIUS, width * .35);
  const points = [[Math.min(.012, width * .55), BASE_Y]];
  for (let i = 0; i <= 8; i++) {
    const a = -Math.PI / 2 + Math.PI * i / 8;
    points.push([radius - Math.cos(a) * radius, noseY + Math.sin(a) * radius]);
  }
  points.push([Math.min(.017, width * .65), TOP_Y], [width, TOP_Y], [width, BASE_Y]);
  if (noseY - radius <= BASE_Y || noseY + radius >= TOP_Y) throw Error('Cushion cross-section does not fit the engine nose height');
  return points;
}

function area2(points) {
  return points.reduce((area, p, i) => { const q = points[(i + 1) % points.length]; return area + p[0] * q[1] - p[1] * q[0]; }, 0);
}

function meshGeometry(THREE, rail) {
  const sections = rail.path.map(({ point: p }) => section(rail.sign * (rail.back - p[rail.across]), p[1]));
  const count = sections[0].length, positions = [], triangles = [];
  for (let i = 0; i < rail.path.length; i++) {
    const front = rail.path[i].point;
    for (const [out, y] of sections[i]) {
      const p = [...front]; p[rail.across] += rail.sign * out; p[1] = y; positions.push(...p);
    }
  }
  const add = (a, b, c, smoothing) => triangles.push({ ids: [a, b, c], smoothing });
  const band = index => index >= 1 && index <= 8 ? 'nose' : `profile-${index}`;
  for (let i = 0; i < rail.path.length - 1; i++) for (let j = 0; j < count; j++) {
    const next = (j + 1) % count;
    const a = i * count + j, b = i * count + next, c = (i + 1) * count + next, d = (i + 1) * count + j;
    add(a, b, c, band(j)); add(a, c, d, band(j));
  }
  for (const [at, reversed] of [[0, true], [sections.length - 1, false]]) {
    const profile = sections[at], winding = Math.sign(area2(profile));
    const caps = THREE.ShapeUtils.triangulateShape(profile.map(p => new THREE.Vector2(...p)), []);
    for (const cap of caps) {
      const [a, b, c] = cap.map(i => profile[i]);
      const sign = Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      if (sign !== winding * (reversed ? -1 : 1)) [cap[1], cap[2]] = [cap[2], cap[1]];
      add(...cap.map(i => at * count + i), `cap-${at}`);
    }
  }
  let volume6 = 0;
  for (const { ids: [a, b, c] } of triangles) {
    const ax = positions[3 * a], ay = positions[3 * a + 1], az = positions[3 * a + 2];
    const bx = positions[3 * b], by = positions[3 * b + 1], bz = positions[3 * b + 2];
    const cx = positions[3 * c], cy = positions[3 * c + 1], cz = positions[3 * c + 2];
    volume6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  if (Math.abs(volume6) < 1e-10) throw Error(`Degenerate closed cushion ${rail.id}`);
  if (volume6 < 0) for (const triangle of triangles) [triangle.ids[1], triangle.ids[2]] = [triangle.ids[2], triangle.ids[1]];

  // Smooth only the actual rounded nose band and tangent-connected path. Flat
  // top/back/bottom and end caps retain separate normals, without a dark fan.
  const normals = new Map();
  for (const { ids, smoothing } of triangles) {
    const [a, b, c] = ids.map(i => positions.slice(i * 3, i * 3 + 3));
    const u = b.map((x, i) => x - a[i]), v = c.map((x, i) => x - a[i]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (Math.hypot(...cross) < 1e-12) throw Error(`Degenerate cushion triangle ${rail.id}`);
    for (const id of ids) {
      const key = `${id}:${smoothing}`, normal = normals.get(key) ?? [0, 0, 0];
      for (let k = 0; k < 3; k++) normal[k] += cross[k];
      normals.set(key, normal);
    }
  }
  const attributes = { positions: [], normals: [], uvs: [], indices: [] }, vertices = new Map();
  const first = rail.path[0].point[rail.along], span = rail.path.at(-1).point[rail.along] - first;
  for (const { ids, smoothing } of triangles) for (const id of ids) {
    const key = `${id}:${smoothing}`;
    if (!vertices.has(key)) {
      vertices.set(key, attributes.positions.length / 3);
      attributes.positions.push(...positions.slice(id * 3, id * 3 + 3));
      const normal = normals.get(key), length = Math.hypot(...normal);
      attributes.normals.push(...normal.map(x => x / length));
      attributes.uvs.push((rail.path[Math.floor(id / count)].point[rail.along] - first) / span, (id % count) / count);
    }
    attributes.indices.push(vertices.get(key));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(attributes.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(attributes.normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(attributes.uvs, 2));
  geometry.setIndex(attributes.indices); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData = { closed: true, signedVolume: Math.abs(volume6) / 6, sections: sections.length, profileVertices: count };
  return geometry;
}

/** One watertight, correctly wound mesh for each of the six complete rail chains. */
export function buildCushionRails(THREE, reference, material) {
  return buildCushionPaths(reference).map(rail => {
    const mesh = new THREE.Mesh(meshGeometry(THREE, rail), material);
    mesh.name = `Rebuilt_Cushion_Rail_${rail.id}`;
    mesh.userData = { cushionRail: { mainId: rail.id, lineIds: rail.lineIds, arcIds: rail.arcIds, contactPath: rail.path.map(entry => [...entry.point]) } };
    return mesh;
  });
}
