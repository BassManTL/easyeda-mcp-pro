import { describe, expect, it } from 'vitest';
import { parseDeviceMetadataInput } from '../src/device-metadata-input.js';
import {
  deviceMetadata,
  fingerprintDevice,
  metadataChangedFields,
  plannedMetadata,
  preservationChecks,
  sameMetadataState,
  snapshotDevice,
} from '../src/device-metadata-state.js';

const uuid = 'a'.repeat(32);
const valid = {
  libraryUuid: uuid,
  deviceUuid: 'b'.repeat(32),
  properties: { 'Review Scope': 'Footprint only' },
  mode: 'preview' as const,
};

describe('Personal Device input preflight', () => {
  it('requires explicit native IDs and nonempty custom values', () => {
    for (const override of [
      { libraryUuid: 'personal' },
      { deviceUuid: uuid.slice(1) },
      { properties: {} },
      { properties: { Count: 1 } },
      { properties: { Review: 'x'.repeat(4097) } },
    ]) {
      expect(() => parseDeviceMetadataInput({ ...valid, ...override })).toThrow();
    }
  });

  it('rejects reserved and dangerous custom property names before contacting EasyEDA', () => {
    for (const name of [
      '__proto__',
      'constructor',
      '3D Model Transform X',
      'Symbol UUID',
      'Footprint',
      '  Review',
      'Review\nState',
    ]) {
      expect(() =>
        parseDeviceMetadataInput({ ...valid, properties: { [name]: 'unsafe' } }),
      ).toThrow();
    }
  });

  it('limits property count, rejects extra fields and requires typed controls', () => {
    expect(() =>
      parseDeviceMetadataInput({
        ...valid,
        properties: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`Custom${i}`, 'ok'])),
      }),
    ).toThrow();
    for (const override of [
      { description: 'not allowed' },
      { mode: 'delete' },
      { thumbnailPolicy: 'omit' },
      { confirmWrite: 'yes' },
      { expectedFingerprint: 'bogus' },
      { expectedThumbnailSha256: 'bogus' },
    ]) {
      expect(() => parseDeviceMetadataInput({ ...valid, ...override })).toThrow();
    }
  });

  it('requires the two independent preview tokens and explicit confirmation for writes', () => {
    const apply = {
      ...valid,
      mode: 'apply',
      thumbnailPolicy: 'reinsert-existing',
      expectedFingerprint: `device-v1:sha256:${'a'.repeat(64)}`,
      expectedThumbnailSha256: 'b'.repeat(64),
      confirmWrite: true,
    };
    expect(parseDeviceMetadataInput(apply)).toMatchObject(apply);
    for (const removed of [
      'expectedFingerprint',
      'expectedThumbnailSha256',
      'confirmWrite',
    ] as const) {
      const copy: Record<string, unknown> = { ...apply };
      delete copy[removed];
      expect(() => parseDeviceMetadataInput(copy)).toThrow();
    }
  });

  it('rejects an unconfirmed apply even if no thumbnail policy is given', () => {
    expect(() => parseDeviceMetadataInput({ ...valid, mode: 'apply' })).toThrow();
  });
});

describe('Device record preservation', () => {
  function original() {
    return {
      uuid,
      description: 'Retained',
      property: { otherProperty: { Existing: 'kept', Review: 'old' } },
      association: {
        images: ['https://image-pro.easyeda.com/pullimages/abc.jpg'],
        symbol: { uuid: 'c'.repeat(32) },
        footprint: { uuid: 'd'.repeat(32) },
      },
      transform: { x: 0, y: 5 },
    };
  }
  it('clones deterministic nested native data but rejects functions, NaN and class instances', async () => {
    const a = original();
    const b = {
      ...a,
      property: { ...a.property, otherProperty: { Review: 'old', Existing: 'kept' } },
    };
    expect(sameMetadataState(a, b)).toBe(true);
    expect(await fingerprintDevice(snapshotDevice(a))).toBe(
      await fingerprintDevice(snapshotDevice(b)),
    );
    expect(() => snapshotDevice({ invalid: Number.NaN })).toThrow();
    expect(() => snapshotDevice({ invalid: () => 'x' })).toThrow();
    expect(() => snapshotDevice({ invalid: new Date() })).toThrow();
  });

  it('reports only requested metadata fields as differences', () => {
    const before = snapshotDevice(original());
    const input = {
      ...valid,
      properties: { Review: 'new' },
      thumbnailPolicy: 'reinsert-existing' as const,
    };
    const after = plannedMetadata(before, input);
    expect(after.properties).toMatchObject({ Review: 'new', Existing: 'kept' });
    expect(metadataChangedFields(deviceMetadata(before), after)).toEqual(['properties.Review']);
    expect(metadataChangedFields(after, after)).toEqual([]);
  });

  it('does not mask unrelated model/geometry changes when thumbnail URL changes', () => {
    const before = snapshotDevice(original());
    const input = { ...valid, thumbnailPolicy: 'reinsert-existing' as const };
    const imageUrlChanged = snapshotDevice(original());
    (imageUrlChanged.association as { images: string[] }).images = [
      'https://image-pro.easyeda.com/pullimages/def.jpg',
    ];
    expect(preservationChecks(before, imageUrlChanged, input, true).every((c) => c.preserved)).toBe(
      true,
    );
    const altered = snapshotDevice(imageUrlChanged);
    (altered.transform as { x: number }).x = 100;
    expect(preservationChecks(before, altered, input, true)[0].preserved).toBe(false);
    expect(
      preservationChecks(before, imageUrlChanged, input, false).find((c) => c.field === 'thumbnail')
        ?.preserved,
    ).toBe(false);
  });
});
