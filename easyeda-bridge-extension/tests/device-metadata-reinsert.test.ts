import { describe, expect, it, vi } from 'vitest';
import { createDeviceMetadataOperations } from '../src/device-metadata-operations.js';
import { createApiRuntime } from '../src/api-runtime.js';
import { createDispatcher } from '../src/dispatcher.js';
import type { DispatcherToolkit } from '../src/toolkit.js';

const libraryUuid = 'a'.repeat(32),
  deviceUuid = 'b'.repeat(32);
const oldUrl = 'https://image-pro.easyeda.com/pullimages/abc.jpg';
const newUrl = 'https://image-pro.easyeda.com/pullimages/def.jpg';
const bytes = new Uint8Array([255, 216, 255, 217]);
const input = {
  libraryUuid,
  deviceUuid,
  properties: { 'Review Status': 'Reviewed - mechanical library' },
  thumbnailPolicy: 'reinsert-existing',
  mode: 'preview',
};
function harness() {
  const record = {
    uuid: deviceUuid,
    libraryUuid,
    name: 'Keep name',
    description: 'Keep description',
    association: {
      images: [oldUrl],
      symbol: { uuid: 'c'.repeat(32), libraryUuid },
      footprint: { uuid: 'd'.repeat(32), libraryUuid },
    },
    property: {
      manufacturer: 'Keep',
      otherProperty: {
        Existing: 'keep',
        '3D Model': 'model',
        '3D Model Transform': 'keep',
      } as Record<string, unknown>,
    },
  };
  const get = vi.fn(async () => structuredClone(record));
  const modify = vi.fn(async (...args: unknown[]) => {
    record.property.otherProperty = {
      ...(args[6] as { otherProperty: Record<string, unknown> }).otherProperty,
    };
    record.association.images = [newUrl];
    return true;
  });
  const version = vi.fn(() => '3.2.206');
  const toolkit: DispatcherToolkit = {
    getEda: () => ({
      lib_Device: { get, modify },
      lib_LibrariesList: { getPersonalLibraryUuid: () => libraryUuid },
      sys_Environment: { getEditorCurrentVersion: version },
    }),
    getEDA: () => undefined,
    getApi: () => undefined,
    getGlobal: () => null,
    log: vi.fn(),
    showToast: vi.fn(),
    getBridgeMaxPayloadSize: () => 1048576,
    getBridgeVersion: () => '1.2.0',
  };
  const runtime = createApiRuntime(toolkit, (code, message) =>
    Object.assign(new Error(message), { code }),
  );
  const fetchImage = vi.fn<typeof fetch>(async () => new Response(bytes, { status: 200 }));
  const operations = createDeviceMetadataOperations({ ...runtime, fetchImage });
  return { record, get, modify, version, toolkit, fetchImage, operations };
}
async function plan(h: ReturnType<typeof harness>) {
  const preview = await h.operations.updateDeviceMetadata(input);
  expect(preview.status).toBe('preview');
  return {
    ...input,
    mode: 'apply',
    confirmWrite: true,
    expectedFingerprint: preview.fingerprintBefore,
    expectedThumbnailSha256: preview.thumbnail!.sha256Before,
  };
}

describe('explicit metadata and existing-thumbnail reinsertion', () => {
  it('rejects a non-Personal library before native modification', async () => {
    const h = harness();
    expect(
      await h.operations.updateDeviceMetadata({ ...input, libraryUuid: 'c'.repeat(32) }),
    ).toMatchObject({
      status: 'rejected',
      writeOutcome: 'not_attempted',
      errors: [{ code: 'LIBRARY_NOT_WRITABLE' }],
    });
    expect(h.modify).not.toHaveBeenCalled();
  });
  it('rejects a mismatched native Device identity', async () => {
    const h = harness();
    h.record.uuid = 'c'.repeat(32);
    expect(await h.operations.updateDeviceMetadata(input)).toMatchObject({
      status: 'rejected',
      errors: [{ code: 'DEVICE_IDENTITY_MISMATCH' }],
    });
    expect(h.modify).not.toHaveBeenCalled();
  });
  it('rejects image retention failure before writing', async () => {
    const h = harness();
    h.fetchImage.mockRejectedValueOnce(Error('network failure'));
    expect(await h.operations.updateDeviceMetadata(input)).toMatchObject({
      status: 'rejected',
      writeOutcome: 'not_attempted',
    });
    expect(h.modify).not.toHaveBeenCalled();
  });
  it('does not report the pre-write snapshot as saved if native readback fails', async () => {
    const h = harness();
    const apply = await plan(h);
    h.get
      .mockResolvedValueOnce(structuredClone(h.record))
      .mockResolvedValueOnce(structuredClone(h.record))
      .mockRejectedValueOnce(Error('readback unavailable'));
    const result = await h.operations.updateDeviceMetadata(apply);
    expect(result).toMatchObject({
      status: 'uncertain',
      writeOutcome: 'acknowledged',
      verified: false,
    });
    expect(result.saved).toBeUndefined();
    expect(h.modify).toHaveBeenCalledOnce();
  });
  it('rejects overlapping requests for the same Device', async () => {
    const h = harness();
    let release!: (value: ReturnType<typeof harness>['record']) => void;
    h.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = h.operations.updateDeviceMetadata(input);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await h.operations.updateDeviceMetadata(input)).toMatchObject({
      status: 'rejected',
      errors: [{ code: 'DEVICE_BUSY' }],
    });
    release(structuredClone(h.record));
    expect((await first).status).toBe('preview');
  });
  it('previews hashes without uploading or implying component validation', async () => {
    const h = harness();
    const preview = await h.operations.updateDeviceMetadata(input);
    expect(preview).toMatchObject({
      status: 'preview',
      writeOutcome: 'not_attempted',
      verified: false,
      runtimeVersion: '3.2.206',
      thumbnail: {
        originalUrl: oldUrl,
        urlMayChange: true,
        reinsertionAttempted: false,
        byteLength: 4,
      },
    });
    expect(preview.thumbnail!.sha256Before).toMatch(/^[a-f0-9]{64}$/);
    expect(h.modify).not.toHaveBeenCalled();
    expect(h.fetchImage).toHaveBeenCalledWith(
      oldUrl,
      expect.objectContaining({
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it('uploads the retained Blob in the same write and verifies content and all other fields', async () => {
    const h = harness();
    const apply = await plan(h);
    const result = await h.operations.updateDeviceMetadata(apply);
    expect(result).toMatchObject({
      status: 'verified',
      writeOutcome: 'acknowledged',
      verified: true,
      thumbnail: { savedUrl: newUrl, bytesIdentical: true, reinsertionAttempted: true },
    });
    expect(result.preservationChecks.every((c) => c.preserved)).toBe(true);
    expect(h.modify).toHaveBeenCalledOnce();
    const args = h.modify.mock.calls[0];
    expect(args.slice(0, 4)).toEqual([deviceUuid, libraryUuid, undefined, undefined]);
    expect(args[5]).toBeUndefined();
    const blob = (args[4] as { imageData: Blob }).imageData;
    expect(blob.type).toBe('image/jpeg');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(args[6]).toEqual({
      otherProperty: {
        Existing: 'keep',
        '3D Model': 'model',
        '3D Model Transform': 'keep',
        'Review Status': 'Reviewed - mechanical library',
      },
    });
    const again = await h.operations.updateDeviceMetadata({
      ...apply,
      expectedFingerprint: result.fingerprintAfter,
    });
    expect(again.status).toBe('unchanged');
    expect(h.modify).toHaveBeenCalledOnce();
  });
  it('requires preview state and image hashes before any native mutation', async () => {
    const h = harness();
    await expect(
      h.operations.updateDeviceMetadata({ ...input, mode: 'apply', confirmWrite: true }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(h.get).not.toHaveBeenCalled();
    expect(h.modify).not.toHaveBeenCalled();
  });
  it('rejects a stale Device fingerprint', async () => {
    const h = harness();
    const apply = await plan(h);
    h.record.description = 'concurrent';
    expect(await h.operations.updateDeviceMetadata(apply)).toMatchObject({
      status: 'rejected',
      writeOutcome: 'not_attempted',
      errors: [{ code: 'STALE_FINGERPRINT' }],
    });
    expect(h.modify).not.toHaveBeenCalled();
  });
  it('rejects image bytes changed at the same URL after preview', async () => {
    const h = harness();
    const apply = await plan(h);
    h.fetchImage.mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255, 1])));
    expect(await h.operations.updateDeviceMetadata(apply)).toMatchObject({
      status: 'rejected',
      errors: [{ code: 'STALE_THUMBNAIL' }],
    });
    expect(h.modify).not.toHaveBeenCalled();
  });
  it('detects concurrent changes during image retention before modifying', async () => {
    const h = harness();
    const apply = await plan(h);
    h.fetchImage.mockImplementationOnce(async () => {
      h.record.description = 'race';
      return new Response(bytes);
    });
    expect(await h.operations.updateDeviceMetadata(apply)).toMatchObject({
      status: 'rejected',
      writeOutcome: 'not_attempted',
      errors: [{ code: 'CONCURRENT_CHANGE' }],
    });
    expect(h.modify).not.toHaveBeenCalled();
  });
  it('fails verification if native upload changes thumbnail content', async () => {
    const h = harness();
    const apply = await plan(h);
    h.fetchImage
      .mockResolvedValueOnce(new Response(bytes))
      .mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255, 1])));
    expect(await h.operations.updateDeviceMetadata(apply)).toMatchObject({
      status: 'verification_failed',
      verified: false,
      thumbnail: { bytesIdentical: false },
    });
    expect(h.modify).toHaveBeenCalledOnce();
  });
  it('reports uncertainty if the saved image cannot be downloaded, with no retry', async () => {
    const h = harness();
    const apply = await plan(h);
    h.fetchImage
      .mockResolvedValueOnce(new Response(bytes))
      .mockRejectedValueOnce(new Error('CORS/network failure'));
    expect(await h.operations.updateDeviceMetadata(apply)).toMatchObject({
      status: 'uncertain',
      verified: false,
      writeOutcome: 'acknowledged',
    });
    expect(h.modify).toHaveBeenCalledOnce();
  });
  it('detects unrelated native field changes', async () => {
    const h = harness();
    const apply = await plan(h);
    const save = h.modify.getMockImplementation()!;
    h.modify.mockImplementationOnce(async (...args) => {
      await save(...args);
      h.record.association.symbol.uuid = 'changed';
      return true;
    });
    const result = await h.operations.updateDeviceMetadata(apply);
    expect(result.status).toBe('verification_failed');
    expect(result.preservationChecks.find((c) => c.field === 'symbol_association')?.preserved).toBe(
      false,
    );
  });
  it('reads back a write that threw after saving and keeps its acknowledgement unknown', async () => {
    const h = harness();
    const apply = await plan(h);
    const save = h.modify.getMockImplementation()!;
    h.modify.mockImplementationOnce(async (...args) => {
      await save(...args);
      throw Error('timeout after save');
    });
    expect(await h.operations.updateDeviceMetadata(apply)).toMatchObject({
      status: 'verified',
      verified: true,
      writeOutcome: 'unknown',
      thumbnail: { bytesIdentical: true },
    });
    expect(h.modify).toHaveBeenCalledOnce();
  });
  it.each([
    { properties: { Count: 1 } },
    { properties: { Flag: true } },
    { description: 'New description' },
    { removeProperties: ['Existing'] },
  ])('rejects unverified operation %j before a write', async (extra) => {
    const h = harness();
    await expect(h.operations.updateDeviceMetadata({ ...input, ...extra })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(h.modify).not.toHaveBeenCalled();
  });
  it('rejects existing nonstring properties rather than coercing unrelated state', async () => {
    const h = harness();
    h.record.property.otherProperty.Count = 1;
    expect((await h.operations.updateDeviceMetadata(input)).errors[0].code).toBe(
      'PROPERTY_TYPE_UNSUPPORTED',
    );
    expect(h.modify).not.toHaveBeenCalled();
  });
  it('rejects unknown native versions and does not download', async () => {
    const h = harness();
    h.version.mockReturnValue('3.2.207');
    expect((await h.operations.updateDeviceMetadata(input)).errors[0].code).toBe(
      'NATIVE_RUNTIME_UNVERIFIED',
    );
    expect(h.fetchImage).not.toHaveBeenCalled();
    expect(h.modify).not.toHaveBeenCalled();
  });
  it.each([[], [oldUrl, newUrl], [''], ['https://localhost/private']])(
    'rejects missing, multiple or unsupported thumbnails: %j',
    async (images) => {
      const h = harness();
      h.record.association.images = images as string[];
      expect((await h.operations.updateDeviceMetadata(input)).status).toBe('rejected');
      expect(h.fetchImage).not.toHaveBeenCalled();
      expect(h.modify).not.toHaveBeenCalled();
    },
  );
  it('exposes the same preview path through the production dispatcher', async () => {
    const h = harness();
    vi.stubGlobal('fetch', h.fetchImage);
    try {
      expect(
        await createDispatcher(h.toolkit).dispatch('library.updateDeviceMetadata', input),
      ).toMatchObject({ status: 'preview', thumbnail: { originalUrl: oldUrl } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('enables only the explicit reinsertion apply path through the production dispatcher', async () => {
    const h = harness();
    vi.stubGlobal('fetch', h.fetchImage);
    try {
      const dispatcher = createDispatcher(h.toolkit);
      const preview = (await dispatcher.dispatch('library.updateDeviceMetadata', input)) as {
        fingerprintBefore: string;
        thumbnail: { sha256Before: string };
      };
      const result = await dispatcher.dispatch('library.updateDeviceMetadata', {
        ...input,
        mode: 'apply',
        confirmWrite: true,
        expectedFingerprint: preview.fingerprintBefore,
        expectedThumbnailSha256: preview.thumbnail.sha256Before,
      });
      expect(result).toMatchObject({ status: 'verified', thumbnail: { bytesIdentical: true } });
      expect(h.modify).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
