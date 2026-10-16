import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { writeModeSchema } from './transaction.js';

const propertyName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      name.trim() === name &&
      !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
      !/^(?:proto|constructor|prototype|name|description|designator|manufacturer|manufacturerid|manufacturerpart|supplier|supplierid|supplierpart|supplierfootprint|lcscpartname|jlcpcbpartclass|symbol|symboluuid|symbollibrary|footprint|footprintuuid|footprintlibrary|(?:3dmodel|model3d|modeltransform).*|addintobom|addintopcb|converttopcb|globalnetname|net)$/i.test(
        name.replace(/[ _-]/g, ''),
      ),
    'Use a custom property name, not a native identity, asset, or reserved field.',
  );
const propertyValue = z.string().max(4096);
export const deviceMetadataInputSchema = z
  .strictObject({
    libraryUuid: z.string().regex(/^[a-fA-F0-9]{32}$/),
    deviceUuid: z.string().regex(/^[a-fA-F0-9]{32}$/),
    properties: z
      .record(propertyName, propertyValue)
      .refine(
        (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 128,
        'Supply between 1 and 128 string property updates.',
      ),
    expectedFingerprint: z
      .string()
      .regex(/^device-v1:sha256:[a-f0-9]{64}$/)
      .optional(),
    thumbnailPolicy: z.literal('reinsert-existing').optional(),
    expectedThumbnailSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    mode: z.enum(['preview', 'apply']).default('apply'),
    confirmWrite: z.boolean().optional(),
    writeMode: writeModeSchema.optional(),
  })
  .refine(
    (input) =>
      input.mode !== 'apply' ||
      input.thumbnailPolicy !== 'reinsert-existing' ||
      Boolean(input.expectedFingerprint && input.expectedThumbnailSha256),
    {
      path: ['expectedFingerprint'],
      message:
        'Apply with thumbnail reinsertion requires the Device fingerprint and thumbnail SHA-256 from preview.',
    },
  )
  .refine((input) => input.mode !== 'apply' || input.confirmWrite === true, {
    path: ['confirmWrite'],
    message: 'Apply requires confirmWrite=true.',
  });

const metadataSchema = z.object({
  properties: z.record(z.string(), z.unknown()),
  description: z.string().nullable().optional(),
});
export const deviceMetadataOutputSchema = z.object({
  libraryUuid: z.string(),
  deviceUuid: z.string(),
  status: z.enum([
    'preview',
    'unchanged',
    'verified',
    'rejected',
    'uncertain',
    'verification_failed',
  ]),
  writeOutcome: z.enum(['not_attempted', 'acknowledged', 'rejected', 'unknown']),
  verified: z.boolean(),
  requested: z.object({
    properties: z.record(z.string(), propertyValue).optional(),
  }),
  saved: metadataSchema.optional(),
  fingerprintBefore: z.string().optional(),
  fingerprintAfter: z.string().optional(),
  runtimeVersion: z.string().optional(),
  thumbnail: z
    .object({
      policy: z.literal('reinsert-existing'),
      originalUrl: z.string(),
      savedUrl: z.string().optional(),
      sha256Before: z.string(),
      sha256After: z.string().optional(),
      byteLength: z.number().int().nonnegative(),
      mimeType: z.enum(['image/png', 'image/jpeg']),
      bytesIdentical: z.boolean().optional(),
      urlMayChange: z.literal(true),
      reinsertionAttempted: z.boolean(),
    })
    .optional(),
  changedFields: z.array(z.string()),
  preservationChecks: z.array(
    z.object({ field: z.string(), preserved: z.boolean(), scope: z.string() }),
  ),
  errors: z.array(
    z.object({ code: z.string(), message: z.string(), field: z.string().optional() }),
  ),
});

export function registerLibraryTools(registry: { register: (def: ToolDefinition) => void }): void {
  registry.register({
    name: 'easyeda_library_update_device_metadata',
    title: 'Update Personal Device metadata safely',
    description:
      'Preview/apply string-valued Personal Device properties with explicit thumbnail reinsertion. Requires preview fingerprint, image hash and confirmWrite. Verifies saved metadata, identical image bytes and preserved fields. Limited to EasyEDA 3.2.206; never infers engineering approval.',
    profile: 'core',
    evidence: ['official-docs', 'pro-api-types'],
    risk: 'medium',
    sideEffect: 'design-mutation',
    confirmWrite: true,
    confirmationPolicy: 'apply-mode',
    group: 'library',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: deviceMetadataInputSchema,
    outputSchema: deviceMetadataOutputSchema,
    handler: async (ctx, input) => {
      const { writeMode: _writeMode, ...params } = deviceMetadataInputSchema.parse(input);
      if (params.mode === 'apply' && params.thumbnailPolicy !== 'reinsert-existing') {
        // A real disposable-Device test on 3.2.206 lost its thumbnail even with
        // a truly omitted association. Only explicit image reinsertion may apply.
        return {
          libraryUuid: params.libraryUuid,
          deviceUuid: params.deviceUuid,
          status: 'rejected',
          writeOutcome: 'not_attempted',
          verified: false,
          requested: {
            properties: params.properties,
          },
          changedFields: [],
          preservationChecks: [],
          errors: [
            {
              code: 'NATIVE_METADATA_WRITES_DISABLED',
              message:
                'Omission-only writes remain disabled. Preview with thumbnailPolicy=reinsert-existing, then apply string property updates using that fingerprint, thumbnail SHA-256 and confirmWrite. No write was attempted.',
            },
          ],
        };
      }
      try {
        return await ctx.bridge.call('library.updateDeviceMetadata', params);
      } catch (error) {
        // An apply transport failure may follow a committed native write. Never retry.
        return {
          libraryUuid: params.libraryUuid,
          deviceUuid: params.deviceUuid,
          status: params.mode === 'apply' ? 'uncertain' : 'rejected',
          writeOutcome: params.mode === 'apply' ? 'unknown' : 'not_attempted',
          verified: false,
          requested: {
            properties: params.properties,
          },
          changedFields: [],
          preservationChecks: [],
          errors: [
            {
              code: params.mode === 'apply' ? 'BRIDGE_WRITE_OUTCOME_UNKNOWN' : 'BRIDGE_READ_FAILED',
              message:
                params.mode === 'apply'
                  ? `${String(error)}. Write outcome unknown. Read back the Device before any retry; no automatic retry was made.`
                  : `${String(error)}. Native preview failed; no write was attempted.`,
            },
          ],
        };
      }
    },
  });
}
