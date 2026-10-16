import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

function bounds(vertices, indices, scale) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const index of indices)
    for (let axis = 0; axis < 3; axis++) {
      const value = vertices[index][axis] * scale;
      if (!Number.isFinite(value)) throw Error('Coordinate conversion overflow');
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  return {
    min,
    max,
    size: max.map((value, axis) => value - min[axis]),
    unit: 'mm',
    referencedVertices: indices.size,
  };
}
function mesh(source) {
  const vertices = [],
    groups = new Map();
  let material = '(default)';
  for (const line of source.split(/\r?\n/)) {
    const [kind, ...values] = line.split('#')[0].trim().split(/\s+/);
    if (kind === 'v') {
      const point = values.slice(0, 3).map(Number);
      if (point.length !== 3 || !point.every(Number.isFinite) || values.length !== 3)
        throw Error('Only finite three-coordinate OBJ vertices are supported');
      vertices.push(point);
    } else if (kind === 'usemtl') material = values.join(' ') || '(default)';
    else if (kind === 'f') {
      if (values.length < 3) throw Error('OBJ face needs at least three vertices');
      const group = groups.get(material) ?? { indices: new Set(), triangles: 0 };
      for (const value of values) {
        const raw = value.split('/')[0];
        if (!/^-?[1-9]\d*$/.test(raw)) throw Error('Invalid OBJ face index');
        const number = Number(raw),
          index = number < 0 ? vertices.length + number : number - 1;
        if (!Number.isSafeInteger(index) || index < 0 || index >= vertices.length)
          throw Error('OBJ face index out of range');
        group.indices.add(index);
      }
      group.triangles += values.length - 2;
      groups.set(material, group);
    }
  }
  if (vertices.length === 0 || groups.size === 0) throw Error('OBJ has no usable face geometry');
  return { vertices, groups };
}
try {
  const [file, units, output, ...selection] = process.argv.slice(2),
    scales = { mm: 1, mil: 0.0254, inch: 25.4 };
  if (!file || !output || !Object.hasOwn(scales, units))
    throw Error('Usage: node measure-obj.mjs MODEL.obj mm|mil|inch NEW_OUTPUT.json [MATERIAL ...]');
  if (statSync(file).size > 67108864) throw Error('OBJ exceeds 64 MiB');
  const bytes = readFileSync(file),
    { vertices, groups } = mesh(bytes.toString('utf8'));
  const selected = selection.length ? selection : [...groups.keys()];
  if (new Set(selected).size !== selected.length || selected.some((name) => !groups.has(name)))
    throw Error('Selected materials must be unique and present in the OBJ');
  const indices = new Set(selected.flatMap((name) => [...groups.get(name).indices]));
  const result = {
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    declaredInputUnits: units,
    selection: selection.length ? 'explicit_materials' : 'entire_mesh_including_any_board',
    selectedMaterials: selected,
    bounds: bounds(vertices, indices, scales[units]),
    materials: Object.fromEntries(
      [...groups].map(([name, group]) => [
        name,
        { ...bounds(vertices, group.indices, scales[units]), triangles: group.triangles },
      ]),
    ),
    limitation:
      'Bounds include only referenced face vertices. Units, part identity, material segmentation and correspondence with the native transform must be verified separately; these bounds alone do not prove model validity.',
  };
  writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(
    JSON.stringify({
      output,
      sourceSha256: result.sourceSha256,
      selection: result.selection,
      bounds: result.bounds,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
