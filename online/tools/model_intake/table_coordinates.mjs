/** One conversion shared by offline table art; authoritative values stay unchanged. */
import TABLE_REFERENCE from './table-reference.json' with {type:'json'};
export {TABLE_REFERENCE};
export function renderPoint(point, reference=TABLE_REFERENCE) {
  return [point[0]-reference.width/2,point[2]||0,reference.length/2-point[1]];
}
export function pocketHoles(reference=TABLE_REFERENCE, extra=0) {
  return reference.pockets.map(pocket => {
    const [x,,z] = renderPoint(pocket.center,reference);
    return {x,z,radius:pocket.radius+extra,id:pocket.id};
  });
}
