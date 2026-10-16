import type { ApiRuntime } from './api-runtime.js';
import {
  requireReinsertionMetadata,
  retainThumbnail,
  singleThumbnailUrl,
  type RetainedThumbnail,
} from './device-metadata-thumbnail.js';
import {
  metadataRecord,
  parseDeviceMetadataInput,
  type DeviceMetadataInput,
} from './device-metadata-input.js';
import {
  deviceMetadata,
  fingerprintDevice,
  metadataChangedFields,
  plannedMetadata,
  preservationChecks,
  sameMetadataState,
  snapshotDevice,
} from './device-metadata-state.js';

type MetadataResult = {
  libraryUuid: string;
  deviceUuid: string;
  status: 'preview' | 'unchanged' | 'verified' | 'rejected' | 'uncertain' | 'verification_failed';
  writeOutcome: 'not_attempted' | 'acknowledged' | 'rejected' | 'unknown';
  verified: boolean;
  requested: Pick<DeviceMetadataInput, 'properties'>;
  saved?: ReturnType<typeof deviceMetadata>;
  fingerprintBefore?: string;
  fingerprintAfter?: string;
  runtimeVersion?: string;
  thumbnail?: {
    policy: 'reinsert-existing';
    originalUrl: string;
    savedUrl?: string;
    sha256Before: string;
    sha256After?: string;
    byteLength: number;
    mimeType: 'image/png' | 'image/jpeg';
    bytesIdentical?: boolean;
    urlMayChange: true;
    reinsertionAttempted: boolean;
  };
  changedFields: string[];
  preservationChecks: ReturnType<typeof preservationChecks>;
  errors: { code: string; message: string; field?: string }[];
};
type Dependencies = Pick<ApiRuntime, 'callFirst' | 'readFirstPath'> & {
  fetchImage?: typeof fetch;
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function errorDetail(error: unknown, fallback: string) {
  const details = error as { code?: unknown; field?: unknown } | undefined;
  return {
    code: typeof details?.code === 'string' ? details.code : fallback,
    message: error instanceof Error ? error.message : String(error),
    field: typeof details?.field === 'string' ? details.field : undefined,
  };
}

async function readDevice(deps: Dependencies, input: DeviceMetadataInput) {
  const raw = await deps.callFirst(['lib_Device.get'], input.deviceUuid, input.libraryUuid);
  if (!raw)
    fail(
      'DEVICE_NOT_FOUND',
      'Device not found in the explicitly named library; no project-cache fallback was used.',
    );
  const record = snapshotDevice(raw);
  if (record.uuid !== input.deviceUuid || record.libraryUuid !== input.libraryUuid)
    fail('DEVICE_IDENTITY_MISMATCH', 'Native read returned a different Device or library.');
  if (!metadataRecord(record.property) || !metadataRecord(record.association))
    fail(
      'UNSUPPORTED_DEVICE_RECORD',
      'Native record must expose complete property and association objects.',
    );
  if (
    record.description !== undefined &&
    record.description !== null &&
    typeof record.description !== 'string'
  )
    fail('UNSUPPORTED_DEVICE_RECORD', 'Native description is not a string.');
  const others = record.property.otherProperty;
  if (others !== undefined && !metadataRecord(others))
    fail('UNSUPPORTED_DEVICE_RECORD', 'Native custom properties are not a map.');
  for (const value of Object.values(others ?? {})) {
    if (!['string', 'number', 'boolean'].includes(typeof value))
      fail(
        'UNSUPPORTED_DEVICE_RECORD',
        'Existing custom properties contain unsupported values; refusing a potentially destructive merge.',
      );
  }
  return record;
}

function requireCapabilities(deps: Dependencies): void {
  for (const path of [
    'lib_Device.get',
    'lib_Device.modify',
    'lib_LibrariesList.getPersonalLibraryUuid',
  ]) {
    if (typeof deps.readFirstPath([path]) !== 'function')
      fail(
        'NATIVE_API_UNAVAILABLE',
        `Required beta API ${path} is unavailable in this EasyEDA runtime.`,
      );
  }
}

async function checkPreconditions(deps: Dependencies, input: DeviceMetadataInput) {
  requireCapabilities(deps);
  const personalUuid = await deps.callFirst(['lib_LibrariesList.getPersonalLibraryUuid']);
  if (personalUuid !== input.libraryUuid)
    fail(
      'LIBRARY_NOT_WRITABLE',
      'Only the current Personal library is supported. Use its explicit UUID; system, project, favorite, team and read-only libraries are not eligible.',
    );
  return readDevice(deps, input);
}

async function applyNative(
  deps: Dependencies,
  input: DeviceMetadataInput,
  before: Record<string, unknown>,
  result: MetadataResult,
  retained?: RetainedThumbnail,
) {
  // One final detached native read protects against edits during preview/preflight.
  // EasyEDA has no conditional-write API; this is not an atomic compare-and-swap.
  const current = await readDevice(deps, input);
  if (!sameMetadataState(before, current))
    fail(
      'CONCURRENT_CHANGE',
      'Device changed during preflight. Preview again; no write was attempted.',
    );
  const planned = plannedMetadata(before, input);
  const property = { otherProperty: { ...planned.properties } };
  result.writeOutcome = 'unknown';
  if (result.thumbnail) result.thumbnail.reinsertionAttempted = true;
  // Do not mislabel the pre-write snapshot as saved state if readback fails.
  delete result.saved;
  try {
    const acknowledged = await deps.callFirst(
      ['lib_Device.modify'],
      input.deviceUuid,
      input.libraryUuid,
      undefined,
      undefined,
      retained ? { imageData: retained.blob } : undefined,
      undefined,
      property,
    );
    result.writeOutcome =
      acknowledged === true ? 'acknowledged' : acknowledged === false ? 'rejected' : 'unknown';
    if (acknowledged !== true)
      result.errors.push({
        code: 'NATIVE_WRITE_NOT_ACKNOWLEDGED',
        message:
          'Native modify did not acknowledge success. Fresh readback is required; no retry was made.',
      });
  } catch (error) {
    result.errors.push(errorDetail(error, 'NATIVE_WRITE_OUTCOME_UNKNOWN'));
  }
  await verifyNative(deps, input, before, planned, result, retained);
}

async function verifyNative(
  deps: Dependencies,
  input: DeviceMetadataInput,
  before: Record<string, unknown>,
  planned: ReturnType<typeof plannedMetadata>,
  result: MetadataResult,
  retained?: RetainedThumbnail,
) {
  let saved: Record<string, unknown>;
  try {
    saved = await readDevice(deps, input);
    result.saved = deviceMetadata(saved);
    result.fingerprintAfter = await fingerprintDevice(saved);
  } catch (error) {
    result.status = 'uncertain';
    result.errors.push(errorDetail(error, 'READBACK_FAILED'));
    return;
  }
  const savedMetadata = deviceMetadata(saved);
  result.changedFields = metadataChangedFields(deviceMetadata(before), savedMetadata);
  let imagePreserved = false;
  let imageUnavailable = false;
  if (retained && result.thumbnail) {
    try {
      const image = await retainThumbnail(singleThumbnailUrl(saved), deps.fetchImage);
      result.thumbnail.savedUrl = image.url;
      result.thumbnail.sha256After = image.sha256;
      imagePreserved = image.sha256 === retained.sha256;
      result.thumbnail.bytesIdentical = imagePreserved;
    } catch (error) {
      imageUnavailable = true;
      result.errors.push(errorDetail(error, 'THUMBNAIL_READBACK_FAILED'));
    }
  }
  result.preservationChecks = preservationChecks(before, saved, input, imagePreserved);
  const valuesMatch = sameMetadataState(planned, savedMetadata);
  result.verified = valuesMatch && result.preservationChecks.every((check) => check.preserved);
  if (imageUnavailable) {
    result.status = 'uncertain';
    return;
  }
  if (result.verified) result.status = 'verified';
  else {
    result.status = result.writeOutcome === 'unknown' ? 'uncertain' : 'verification_failed';
    result.errors.push({
      code: 'READBACK_MISMATCH',
      message:
        'Fresh native readback differs from requested metadata or an unrelated field changed. Do not retry or restore automatically; inspect the Device and concurrent edits.',
    });
  }
}

async function prepareThumbnail(
  deps: Dependencies,
  input: DeviceMetadataInput,
  before: Record<string, unknown>,
  result: MetadataResult,
): Promise<RetainedThumbnail | undefined> {
  if (input.thumbnailPolicy !== 'reinsert-existing') return undefined;
  requireReinsertionMetadata(input, before);
  const version = await deps.callFirst(['sys_Environment.getEditorCurrentVersion'], true);
  result.runtimeVersion = String(version);
  if (version !== '3.2.206')
    fail(
      'NATIVE_RUNTIME_UNVERIFIED',
      'Thumbnail reinsertion is currently verified only on EasyEDA Pro 3.2.206.',
    );
  const retained = await retainThumbnail(singleThumbnailUrl(before), deps.fetchImage);
  result.thumbnail = {
    policy: 'reinsert-existing',
    originalUrl: retained.url,
    sha256Before: retained.sha256,
    byteLength: retained.bytes.byteLength,
    mimeType: retained.mimeType,
    urlMayChange: true,
    reinsertionAttempted: false,
  };
  if (input.expectedThumbnailSha256 && input.expectedThumbnailSha256 !== retained.sha256)
    fail('STALE_THUMBNAIL', 'Thumbnail bytes changed since preview. No write was attempted.');
  return retained;
}

export function createDeviceMetadataOperations(deps: Dependencies) {
  const inFlight = new Set<string>();
  return {
    async updateDeviceMetadata(params: Record<string, unknown>): Promise<MetadataResult> {
      const input = parseDeviceMetadataInput(params);
      const result: MetadataResult = {
        libraryUuid: input.libraryUuid,
        deviceUuid: input.deviceUuid,
        status: 'rejected',
        writeOutcome: 'not_attempted',
        verified: false,
        requested: {
          properties: input.properties,
        },
        changedFields: [],
        preservationChecks: [],
        errors: [],
      };
      if (input.mode === 'apply' && input.thumbnailPolicy !== 'reinsert-existing') {
        result.errors.push({
          code: 'NATIVE_METADATA_WRITES_DISABLED',
          message:
            'Omission-only writes remain disabled. Preview with thumbnailPolicy=reinsert-existing before applying string property updates with its Device fingerprint and image hash.',
        });
        return result;
      }
      const key = `${input.libraryUuid}/${input.deviceUuid}`;
      if (inFlight.has(key)) {
        result.errors.push({
          code: 'DEVICE_BUSY',
          message:
            'Another metadata request for this Device is in progress. Wait and preview again.',
        });
        return result;
      }
      inFlight.add(key);
      try {
        const before = await checkPreconditions(deps, input);
        result.fingerprintBefore = await fingerprintDevice(before);
        result.saved = deviceMetadata(before);
        if (input.expectedFingerprint && input.expectedFingerprint !== result.fingerprintBefore)
          fail(
            'STALE_FINGERPRINT',
            'Device changed since the expected fingerprint. Preview again before applying.',
          );
        const planned = plannedMetadata(before, input);
        const plannedFields = metadataChangedFields(result.saved, planned);
        const retained = await prepareThumbnail(deps, input, before, result);
        if (input.mode === 'preview') {
          result.status = 'preview';
          result.changedFields = plannedFields;
          return result;
        }
        if (!plannedFields.length) {
          result.status = 'unchanged';
          result.verified = true;
          result.fingerprintAfter = result.fingerprintBefore;
          result.preservationChecks = preservationChecks(
            before,
            before,
            input,
            retained !== undefined,
          );
          if (result.thumbnail) result.thumbnail.bytesIdentical = true;
          return result;
        }
        await applyNative(deps, input, before, result, retained);
      } catch (error) {
        result.status = result.writeOutcome === 'not_attempted' ? 'rejected' : 'uncertain';
        result.errors.push(errorDetail(error, 'PREFLIGHT_FAILED'));
      } finally {
        inFlight.delete(key);
      }
      return result;
    },
  };
}
