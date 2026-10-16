import { metadataRecord, type DeviceMetadataInput } from './device-metadata-input.js';

// Only plain native data can be verified. Never stringify opaque assets, blobs,
// getters returning functions, or class instances into misleading empty objects.
export function snapshotDevice(value: unknown): Record<string, unknown> {
  if (!metadataRecord(value)) throw new Error('Native Device record is missing.');
  const clone = (entry: unknown): unknown => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(clone);
    if (!metadataRecord(entry) || ![Object.prototype, null].includes(Object.getPrototypeOf(entry)))
      throw new Error('Native Device contains unsupported data; preservation cannot be verified.');
    return Object.fromEntries(
      Object.keys(entry)
        .sort()
        .filter((key) => entry[key] !== undefined)
        .map((key) => [key, clone(entry[key])]),
    );
  };
  return clone(value) as Record<string, unknown>;
}

export function sameMetadataState(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(snapshotDevice({ value: left })) ===
    JSON.stringify(snapshotDevice({ value: right }))
  );
}

export async function fingerprintDevice(record: Record<string, unknown>): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error(
      'crypto.subtle is unavailable; cannot fingerprint or safely update this Device.',
    );
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(record)),
  );
  return `device-v1:sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function deviceMetadata(record: Record<string, unknown>) {
  const property = record.property as Record<string, unknown>;
  return {
    properties: (property.otherProperty ?? {}) as Record<string, unknown>,
    description: record.description as string | null | undefined,
  };
}

export function plannedMetadata(before: Record<string, unknown>, input: DeviceMetadataInput) {
  const metadata = deviceMetadata(before);
  const properties = { ...metadata.properties, ...input.properties };
  return {
    properties,
    description: metadata.description,
  };
}

export function metadataChangedFields(
  before: ReturnType<typeof deviceMetadata>,
  after: ReturnType<typeof deviceMetadata>,
): string[] {
  const fields = [...new Set([...Object.keys(before.properties), ...Object.keys(after.properties)])]
    .sort()
    .filter((key) => !sameMetadataState(before.properties[key], after.properties[key]))
    .map((key) => `properties.${key}`);
  if (before.description !== after.description) fields.push('description');
  return fields;
}

function withoutRequested(record: Record<string, unknown>, input: DeviceMetadataInput) {
  const stripped = snapshotDevice(record);
  if (input.thumbnailPolicy === 'reinsert-existing')
    delete (stripped.association as Record<string, unknown>).images;
  const property = stripped.property as Record<string, unknown>;
  const others = property.otherProperty as Record<string, unknown> | undefined;
  if (others) {
    for (const key of Object.keys(input.properties)) delete others[key];
    if (!Object.keys(others).length) delete property.otherProperty;
  }
  return stripped;
}

function assetFields(record: Record<string, unknown>, pattern: RegExp): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  const visit = (value: unknown, prefix: string) => {
    if (!metadataRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      const path = `${prefix}/${key}`;
      if (pattern.test(key)) found[path] = entry;
      else visit(entry, path);
    }
  };
  visit(record, '');
  return found;
}

export function preservationChecks(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  input: DeviceMetadataInput,
  thumbnailBytesPreserved = false,
) {
  const checks = [
    {
      field: 'all_unrequested_native_fields',
      preserved: sameMetadataState(withoutRequested(before, input), withoutRequested(after, input)),
      scope:
        'Entire fresh native record, excluding requested metadata and, only for explicit reinsertion, association.images URLs. Thumbnail bytes are checked separately.',
    },
  ];
  const groups = [
    ['thumbnail', /image|thumbnail/i],
    ['symbol_association', /symbol/i],
    ['footprint_association', /footprint/i],
    ['model_reference', /model3d|3dmodel|3d model|model(reference|uuid)/i],
    ['model_transform', /transform|rotation|offset|scale|3d.*(origin|position)/i],
  ] as const;
  for (const [field, pattern] of groups) {
    if (field === 'thumbnail' && input.thumbnailPolicy === 'reinsert-existing') {
      checks.push({
        field,
        preserved: thumbnailBytesPreserved,
        scope:
          'Existing image bytes reinserted and SHA-256 checked at the saved native URL; URL may change. Other image fields remain covered by the whole-record comparison.',
      });
      continue;
    }
    const original = assetFields(withoutRequested(before, input), pattern);
    const saved = assetFields(withoutRequested(after, input), pattern);
    checks.push({
      field,
      preserved: sameMetadataState(original, saved),
      scope:
        Object.keys(original).length || Object.keys(saved).length
          ? 'All matching fields exposed by native LIB_Device.get; referenced asset contents are not read or certified.'
          : 'No matching fields exposed by LIB_Device.get; only absence in that record is checked. Referenced asset contents are unverified.',
    });
  }
  return checks;
}
