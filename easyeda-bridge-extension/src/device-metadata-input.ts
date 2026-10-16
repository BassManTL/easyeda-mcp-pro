export interface DeviceMetadataInput {
  libraryUuid: string;
  deviceUuid: string;
  properties: Record<string, string>;
  expectedFingerprint?: string;
  thumbnailPolicy?: 'reinsert-existing';
  expectedThumbnailSha256?: string;
  mode: 'preview' | 'apply';
  confirmWrite?: boolean;
}

export function metadataRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(field: string, message: string): never {
  throw Object.assign(new Error(message), { code: 'INVALID_INPUT', field });
}

function validateProperties(value: unknown): asserts value is Record<string, string> {
  if (!metadataRecord(value) || !Object.keys(value).length || Object.keys(value).length > 128)
    invalid('properties', 'Supply between 1 and 128 string property updates.');
  for (const [name, entry] of Object.entries(value)) {
    if (
      !name.length ||
      name.length > 255 ||
      name.trim() !== name ||
      Array.from(name).some((c) => c.charCodeAt(0) < 32) ||
      /^(?:proto|constructor|prototype|name|description|designator|manufacturer|manufacturerid|manufacturerpart|supplier|supplierid|supplierpart|supplierfootprint|lcscpartname|jlcpcbpartclass|symbol|symboluuid|symbollibrary|footprint|footprintuuid|footprintlibrary|(?:3dmodel|model3d|modeltransform).*|addintobom|addintopcb|converttopcb|globalnetname|net)$/i.test(
        name.replace(/[ _-]/g, ''),
      )
    )
      invalid('properties', 'Use custom property names, not identity, asset or reserved fields.');
    if (typeof entry !== 'string' || entry.length > 4096)
      invalid('properties', 'Custom values must be strings of at most 4096 characters.');
  }
}

function validateTokens(params: Record<string, unknown>): void {
  if (
    params.expectedFingerprint !== undefined &&
    (typeof params.expectedFingerprint !== 'string' ||
      !/^device-v1:sha256:[a-f0-9]{64}$/.test(params.expectedFingerprint))
  )
    invalid('expectedFingerprint', 'Use the Device fingerprint returned by preview.');
  if (
    params.expectedThumbnailSha256 !== undefined &&
    (typeof params.expectedThumbnailSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(params.expectedThumbnailSha256))
  )
    invalid('expectedThumbnailSha256', 'Use the thumbnail hash returned by preview.');
}

function validateControls(params: Record<string, unknown>): 'preview' | 'apply' {
  const mode = params.mode ?? 'apply';
  if (mode !== 'preview' && mode !== 'apply') invalid('mode', 'Use preview or apply.');
  if (params.confirmWrite !== undefined && typeof params.confirmWrite !== 'boolean')
    invalid('confirmWrite', 'Confirmation must be a boolean.');
  if (mode === 'apply' && params.confirmWrite !== true)
    invalid('confirmWrite', 'Apply requires confirmWrite=true.');
  if (params.thumbnailPolicy !== undefined && params.thumbnailPolicy !== 'reinsert-existing')
    invalid('thumbnailPolicy', 'Use reinsert-existing to authorize thumbnail reinsertion.');
  if (
    mode === 'apply' &&
    params.thumbnailPolicy === 'reinsert-existing' &&
    (!params.expectedFingerprint || !params.expectedThumbnailSha256)
  )
    invalid('expectedFingerprint', 'Apply requires both preview fingerprint and thumbnail hash.');
  return mode;
}

export function parseDeviceMetadataInput(params: Record<string, unknown>): DeviceMetadataInput {
  const allowed = new Set([
    'libraryUuid',
    'deviceUuid',
    'properties',
    'expectedFingerprint',
    'expectedThumbnailSha256',
    'thumbnailPolicy',
    'mode',
    'confirmWrite',
  ]);
  for (const key of Object.keys(params))
    if (!allowed.has(key)) invalid(key, 'Unsupported metadata field.');
  for (const key of ['libraryUuid', 'deviceUuid'])
    if (typeof params[key] !== 'string' || !/^[a-fA-F0-9]{32}$/.test(params[key]))
      invalid(key, 'Supply an explicit 32-character hexadecimal UUID.');
  const mode = validateControls(params);
  validateTokens(params);
  validateProperties(params.properties);
  return { ...params, mode } as unknown as DeviceMetadataInput;
}
