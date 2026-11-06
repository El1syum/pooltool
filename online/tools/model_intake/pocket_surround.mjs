/** Rebuilt cosmetic woodwork and pocket linings. No collision data is changed. */
import {pocketHoles} from './table_coordinates.mjs';

const TAU = Math.PI * 2;
const epsilon = 1e-8;
const pointKey = p => p.map(value => Math.round(value / epsilon)).join(',');
export const WOOD_UV_PATCH = Object.freeze({u:.18,v:.305,width:.06,height:.06});

/** Boundary of a rectangle union its intersecting circular pocket clearances. */
export function openingContour(reference, extra = .01, backWidth = .06) {
  const halfX = reference.width / 2 + backWidth;
  const halfZ = reference.length / 2 + backWidth;
  const holes = pocketHoles(reference, extra);
  const corners = [[-halfX,-halfZ],[halfX,-halfZ],[halfX,halfZ],[-halfX,halfZ]];
  const segments = [], angles = holes.map(() => []);
  const insideRectangle = ([x,z]) => Math.abs(x) < halfX - epsilon && Math.abs(z) < halfZ - epsilon;
  for (let side = 0; side < corners.length; side++) {
    const start = corners[side], end = corners[(side + 1) % corners.length];
    const dx = end[0] - start[0], dz = end[1] - start[1];
    const cuts = [0,1];
    for (const [index,hole] of holes.entries()) {
      const x = start[0] - hole.x, z = start[1] - hole.z;
      const a = dx * dx + dz * dz, b = 2 * (x * dx + z * dz);
      const discriminant = b * b - 4 * a * (x * x + z * z - hole.radius * hole.radius);
      if (discriminant < 0) continue;
      for (const t of [(-b - Math.sqrt(discriminant)) / (2 * a),(-b + Math.sqrt(discriminant)) / (2 * a)]) {
        if (t < -epsilon || t > 1 + epsilon) continue;
        const clamped = Math.max(0,Math.min(1,t));
        cuts.push(clamped);
        angles[index].push((Math.atan2(start[1] + dz * clamped - hole.z,start[0] + dx * clamped - hole.x) + TAU) % TAU);
      }
    }
    cuts.sort((a,b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i], b = cuts[i + 1];
      if (b - a < epsilon) continue;
      const mid = [start[0] + dx * (a + b) / 2,start[1] + dz * (a + b) / 2];
      if (holes.some(hole => Math.hypot(mid[0] - hole.x,mid[1] - hole.z) < hole.radius - epsilon)) continue;
      segments.push([[start[0] + dx * a,start[1] + dz * a],[start[0] + dx * b,start[1] + dz * b]]);
    }
  }
  for (const [index,hole] of holes.entries()) {
    const stops = [...new Set(angles[index])].sort((a,b) => a - b);
    if (!stops.length) {
      if (!insideRectangle([hole.x + hole.radius,hole.z])) throw Error('A detached pocket clearance is unsupported');
      continue;
    }
    for (let i = 0; i < stops.length; i++) {
      const start = stops[i], end = stops[(i + 1) % stops.length] + (i + 1 === stops.length ? TAU : 0);
      const midpoint = (start + end) / 2;
      if (insideRectangle([hole.x + Math.cos(midpoint) * hole.radius,hole.z + Math.sin(midpoint) * hole.radius])) continue;
      const count = Math.max(2,Math.ceil((end - start) * 64 / Math.PI));
      const points = Array.from({length:count + 1},(_,step) => {
        const angle = start + (end - start) * step / count;
        return [hole.x + Math.cos(angle) * hole.radius,hole.z + Math.sin(angle) * hole.radius];
      });
      for (let step = 0; step < count; step++) segments.push([points[step],points[step + 1]]);
    }
  }
  const outgoing = new Map(segments.map(segment => [pointKey(segment[0]),segment]));
  if (outgoing.size !== segments.length) throw Error('Pocket clearance boundary has branching vertices');
  const first = segments[0], contour = [], visited = new Set();
  let segment = first;
  while (segment && !visited.has(segment)) {
    visited.add(segment); contour.push(segment[0]); segment = outgoing.get(pointKey(segment[1]));
  }
  if (segment !== first || visited.size !== segments.length) throw Error('Pocket clearances must form one closed boundary');
  return contour;
}

export function buildWoodDeck(THREE, reference, material) {
  const halfX = reference.width / 2 + .16, halfZ = reference.length / 2 + .16, radius = .035;
  const shape = new THREE.Shape();
  shape.moveTo(-halfX + radius,-halfZ);
  shape.lineTo(halfX - radius,-halfZ); shape.quadraticCurveTo(halfX,-halfZ,halfX,-halfZ + radius);
  shape.lineTo(halfX,halfZ - radius); shape.quadraticCurveTo(halfX,halfZ,halfX - radius,halfZ);
  shape.lineTo(-halfX + radius,halfZ); shape.quadraticCurveTo(-halfX,halfZ,-halfX,halfZ - radius);
  shape.lineTo(-halfX,-halfZ + radius); shape.quadraticCurveTo(-halfX,-halfZ,-halfX + radius,-halfZ);
  const opening = new THREE.Path(openingContour(reference).map(point => new THREE.Vector2(...point)));
  opening.closePath(); shape.holes.push(opening);
  // The closed apron overlaps the retained lower cabinet, rather than leaving
  // the clean upper deck apparently suspended above the original AI base.
  const geometry = new THREE.ExtrudeGeometry(shape,{depth:.23,bevelEnabled:false,curveSegments:16,steps:1});
  geometry.rotateX(Math.PI / 2); geometry.translate(0,.05,0);
  // Reuse a clean wooden region of the supplied AI atlas, without editing it.
  const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
  for (let i = 0; i < position.count; i++) uv.setXY(i,WOOD_UV_PATCH.u + WOOD_UV_PATCH.width * (position.getZ(i) + halfZ) / (2 * halfZ),WOOD_UV_PATCH.v + WOOD_UV_PATCH.height * (position.getX(i) + halfX) / (2 * halfX));
  const mesh = new THREE.Mesh(geometry,material);
  mesh.name = 'Rebuilt_Upper_Wood_Deck';
  mesh.userData.preparation = 'Continuous timber deck with union-shaped pocket cuts; original AI wood atlas reused';
  return mesh;
}

/** Low entrance, raised outside collar, continuous dark inner/outer walls. */
export function buildPocketLinings(THREE, reference, material) {
  const halfX = reference.width / 2 + .06, halfZ = reference.length / 2 + .06;
  const height = (x,z) => {
    const distance = Math.max(Math.abs(x) - halfX,Math.abs(z) - halfZ);
    const t = Math.max(0,Math.min(1,(distance + .012) / .015));
    return -.0018 + .0523 * t * t * (3 - 2 * t);
  };
  return pocketHoles(reference).map(hole => {
    const count = 128, positions = [], surfaces = [[],[],[],[]];
    for (let ring = 0; ring < 4; ring++) for (let i = 0; i < count; i++) {
      const angle = i * TAU / count, radius = hole.radius + (ring % 2 ? .012 : 0);
      const x = hole.x + Math.cos(angle) * radius, z = hole.z + Math.sin(angle) * radius;
      positions.push(x,ring < 2 ? height(x,z) : -.22,z);
    }
    const quad = (surface,a,b,c,d) => surfaces[surface].push(a,c,b,a,d,c);
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      quad(0,i,count + i,count + next,next); // Upward collar.
      quad(1,i,next,2 * count + next,2 * count + i); // Into the open well.
      quad(2,count + i,3 * count + i,3 * count + next,count + next);
      quad(3,2 * count + i,2 * count + next,3 * count + next,3 * count + i);
    }
    // The collar, inner bore, outside wall and underside meet at hard creases.
    // Smooth around each ring, not across opposite-facing lining surfaces.
    const splitPositions = [], indices = [];
    for (const surface of surfaces) {
      const vertices = new Map();
      for (const original of surface) {
        if (!vertices.has(original)) {
          vertices.set(original,splitPositions.length / 3);
          splitPositions.push(...positions.slice(original * 3,original * 3 + 3));
        }
        indices.push(vertices.get(original));
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(splitPositions,3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry,material);
    mesh.name = `Rebuilt_Open_Pocket_Well_${hole.id}`;
    return mesh;
  });
}
