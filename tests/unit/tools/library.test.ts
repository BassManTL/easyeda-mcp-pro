import { describe, expect, it, vi } from 'vitest';
import { registerLibraryTools, deviceMetadataInputSchema } from '../../../src/tools/L1_library.js';
import {
  ToolRegistry,
  getRequiredToolScopes,
  remoteRiskForTool,
} from '../../../src/tools/registry.js';
import type { ToolContext } from '../../../src/tools/types.js';
import type { McpServer } from '@modelcontextprotocol/server';

const input = {
  libraryUuid: 'a'.repeat(32),
  deviceUuid: 'b'.repeat(32),
  properties: { 'Review Notes': 'Keep bindings' },
  confirmWrite: true,
};

describe('library metadata tool contract', () => {
  const reinsertion = {
    ...input,
    thumbnailPolicy: 'reinsert-existing',
    expectedFingerprint: `device-v1:sha256:${'1'.repeat(64)}`,
    expectedThumbnailSha256: '2'.repeat(64),
  };
  it('routes explicit reinsertion apply through the controlled bridge', async () => {
    const registry = new ToolRegistry();
    registerLibraryTools(registry);
    const call = vi.fn().mockResolvedValue({ status: 'verified' });
    await registry
      .get('easyeda_library_update_device_metadata')!
      .handler({ bridge: { call } } as unknown as ToolContext, reinsertion);
    expect(call).toHaveBeenCalledWith('library.updateDeviceMetadata', {
      ...reinsertion,
      mode: 'apply',
    });
  });
  it('requires both preview tokens for explicit reinsertion apply', () => {
    expect(
      deviceMetadataInputSchema.safeParse({ ...reinsertion, expectedFingerprint: undefined })
        .success,
    ).toBe(false);
    expect(
      deviceMetadataInputSchema.safeParse({ ...reinsertion, expectedThumbnailSha256: undefined })
        .success,
    ).toBe(false);
    expect(
      deviceMetadataInputSchema.safeParse({
        ...input,
        thumbnailPolicy: 'reinsert-existing',
        mode: 'preview',
        confirmWrite: undefined,
      }).success,
    ).toBe(true);
  });
  it('reports an apply transport timeout as an unknown outcome without retrying', async () => {
    const registry = new ToolRegistry();
    registerLibraryTools(registry);
    const call = vi.fn().mockRejectedValue(new Error('transport timeout'));
    const tool = registry.get('easyeda_library_update_device_metadata')!;
    const result = await tool.handler({ bridge: { call } } as unknown as ToolContext, reinsertion);
    expect(result).toMatchObject({
      status: 'uncertain',
      writeOutcome: 'unknown',
      verified: false,
      errors: [{ code: 'BRIDGE_WRITE_OUTCOME_UNKNOWN' }],
    });
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
    expect(call).toHaveBeenCalledOnce();
  });
  it('enforces library scope and confirmation at the registered MCP boundary', async () => {
    const registry = new ToolRegistry();
    registerLibraryTools(registry);
    let handler!: (
      input: unknown,
    ) => Promise<{ isError?: boolean; structuredContent?: unknown; content: { text: string }[] }>;
    const server = {
      registerTool: (_name: string, _definition: unknown, registered: typeof handler) => {
        handler = registered;
      },
    };
    const call = vi.fn().mockResolvedValue({
      libraryUuid: input.libraryUuid,
      deviceUuid: input.deviceUuid,
      status: 'preview',
      writeOutcome: 'not_attempted',
      verified: false,
      requested: { properties: input.properties },
      changedFields: [],
      preservationChecks: [],
      errors: [],
    });
    const context = {
      profile: 'core',
      bridge: { connected: true, call },
      config: { TOOL_SCOPES: 'api:read' },
    } as unknown as ToolContext;
    registry.registerAllOnServer(server as unknown as McpServer, context);
    expect((await handler(input)).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
    context.config.TOOL_SCOPES = 'library:write';
    const staticPlan = await handler({ ...input, writeMode: 'preview', confirmWrite: undefined });
    expect(staticPlan.isError).toBeFalsy();
    expect(staticPlan.structuredContent).toMatchObject({ transaction: { willApply: false } });
    expect(call).not.toHaveBeenCalled();
    const blocked = await handler({ ...input, mode: 'apply', confirmWrite: undefined });
    expect(blocked.content[0].text).toContain('ERR_CONFIRM_WRITE_REQUIRED');
    expect(call).not.toHaveBeenCalled();
    const preview = await handler({ ...input, mode: 'preview', confirmWrite: undefined });
    expect(preview.isError).toBeFalsy();
    expect(call).toHaveBeenCalledOnce();
  });

  it('requires confirmation and write authorization and uses the controlled bridge only', async () => {
    const registry = new ToolRegistry();
    registerLibraryTools(registry);
    const tool = registry.get('easyeda_library_update_device_metadata')!;
    expect(tool).toMatchObject({
      sideEffect: 'design-mutation',
      confirmWrite: true,
      confirmationPolicy: 'apply-mode',
      risk: 'medium',
    });
    expect(getRequiredToolScopes(tool)).toEqual(['library:write']);
    expect(remoteRiskForTool(tool)).toBe('write');
    const call = vi.fn().mockResolvedValue({ status: 'verified' });
    await tool.handler({ bridge: { call } } as unknown as ToolContext, {
      ...input,
      mode: 'preview',
    });
    expect(call).toHaveBeenCalledWith('library.updateDeviceMetadata', {
      ...input,
      mode: 'preview',
    });
  });

  it.each([
    { properties: {} },
    { properties: { Count: 1 } },
    { properties: { Flag: true } },
    { properties: { '3D Model Transform': 'changed' } },
    { properties: { constructor: 'changed' } },
    { properties: { 'Review Status': 'x'.repeat(4097) } },
    { deviceUuid: 'wrong' },
    { description: null },
    { properties: null },
    { properties: { A: null } },
    { association: {} },
    { description: 'a'.repeat(256) },
    { confirmWrite: false },
  ])('rejects null, unrelated fields and invalid values: %j', (extra) => {
    expect(deviceMetadataInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  });

  it('retains omission across JSON and permits preview without confirmation', () => {
    const parsed = deviceMetadataInputSchema.parse(
      JSON.parse(JSON.stringify({ ...input, mode: 'preview', confirmWrite: undefined })),
    );
    expect(parsed.expectedFingerprint).toBeUndefined();
    expect(parsed.expectedThumbnailSha256).toBeUndefined();
  });

  it('reports a preview transport failure without writing or retrying', async () => {
    const registry = new ToolRegistry();
    registerLibraryTools(registry);
    const tool = registry.get('easyeda_library_update_device_metadata')!;
    const call = vi.fn().mockRejectedValue(new Error('Bridge timeout'));
    const result = await tool.handler({ bridge: { call } } as unknown as ToolContext, {
      ...input,
      mode: 'preview',
    });
    expect(result).toMatchObject({
      status: 'rejected',
      writeOutcome: 'not_attempted',
      verified: false,
    });
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('blocks production apply before any bridge call after the live preservation failure', async () => {
    const registry = new ToolRegistry();
    registerLibraryTools(registry);
    const call = vi.fn();
    const tool = registry.get('easyeda_library_update_device_metadata')!;
    const result = await tool.handler({ bridge: { call } } as unknown as ToolContext, input);
    expect(result).toMatchObject({
      status: 'rejected',
      writeOutcome: 'not_attempted',
      errors: [{ code: 'NATIVE_METADATA_WRITES_DISABLED' }],
    });
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});
