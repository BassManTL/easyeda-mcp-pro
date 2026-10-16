import { describe, expect, it, vi } from 'vitest';
import { buildSync } from 'esbuild';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { requireThumbnailUrl, retainThumbnail } from '../src/device-metadata-thumbnail.js';
const url = 'https://image-pro.easyeda.com/pullimages/abc.jpg';
describe('bounded native thumbnail downloads', () => {
  it('uses the browser global when EasyEDA shadows the bare AbortController constructor', async () => {
    const bundle = buildSync({
      entryPoints: [fileURLToPath(new URL('../src/device-metadata-thumbnail.ts', import.meta.url))],
      bundle: true,
      format: 'iife',
      globalName: 'thumbnailModule',
      platform: 'browser',
      write: false,
    }).outputFiles[0]!.text;
    const context = {
      AbortController,
      Blob,
      crypto: webcrypto,
      setTimeout,
      clearTimeout,
      download: undefined as typeof retainThumbnail | undefined,
    };
    vm.runInNewContext(
      `{ const AbortController = undefined; ${bundle}; download = thumbnailModule.retainThumbnail; }`,
      context,
    );
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array([255, 216, 255])));
    const image = await context.download!(url, fetchImage);
    expect(image.mimeType).toBe('image/jpeg');
    expect(image.sha256).toHaveLength(64);
    expect(fetchImage.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });
  it('fails before fetching when the browser cannot abort a bounded download', async () => {
    const fetchImage = vi.fn<typeof fetch>();
    vi.stubGlobal('AbortController', undefined);
    try {
      await expect(retainThumbnail(url, fetchImage)).rejects.toMatchObject({
        code: 'THUMBNAIL_DOWNLOAD_FAILED',
      });
      expect(fetchImage).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([
    'http://image-pro.easyeda.com/pullimages/abc.jpg',
    'https://image-pro.easyeda.com.evil.test/pullimages/abc.jpg',
    'https://user@image-pro.easyeda.com/pullimages/abc.jpg',
    'https://image-pro.easyeda.com:443/pullimages/abc.jpg',
    'https://127.0.0.1/a.jpg',
    'https://image-pro.easyeda.com/pullimages/abc.jpg?q=1',
    'https://image-pro.easyeda.com/pullimages/abc.jpg#x',
    'https://alimg.szlcsc.com/upload/public/product/middle/../private.jpg',
    'data:image/jpeg;base64,/9j/',
  ])('rejects unsupported URL without fetching: %s', async (value) => {
    const fetchImage = vi.fn<typeof fetch>();
    await expect(retainThumbnail(value, fetchImage)).rejects.toMatchObject({
      code: 'THUMBNAIL_URL_UNSUPPORTED',
    });
    expect(fetchImage).not.toHaveBeenCalled();
  });
  it('accepts supported public LCSC product images', () => {
    expect(
      requireThumbnailUrl('https://alimg.szlcsc.com/upload/public/product/middle/20230102/ABC.jpg'),
    ).toContain('ABC.jpg');
  });
  it('checks declared size before reading a body', async () => {
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(new Uint8Array([1]), { headers: { 'content-length': '524289' } }),
      );
    await expect(retainThumbnail(url, fetchImage)).rejects.toMatchObject({
      code: 'THUMBNAIL_TOO_LARGE',
    });
  });
  it('caps streamed data even without content-length', async () => {
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array(524289)));
    await expect(retainThumbnail(url, fetchImage)).rejects.toMatchObject({
      code: 'THUMBNAIL_TOO_LARGE',
    });
  });
  it('rejects invalid image signatures and HTTP failure', async () => {
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not an image'))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(retainThumbnail(url, fetchImage)).rejects.toMatchObject({
      code: 'THUMBNAIL_FORMAT_UNSUPPORTED',
    });
    await expect(retainThumbnail(url, fetchImage)).rejects.toMatchObject({
      code: 'THUMBNAIL_DOWNLOAD_FAILED',
    });
  });
  it('does not accept a redirected response even if a fetch adapter ignores redirect:error', async () => {
    const response = new Response(new Uint8Array([255, 216, 255]));
    Object.defineProperty(response, 'redirected', { value: true });
    await expect(
      retainThumbnail(url, vi.fn<typeof fetch>().mockResolvedValue(response)),
    ).rejects.toMatchObject({ code: 'THUMBNAIL_DOWNLOAD_FAILED' });
  });
  it('aborts a stalled request within the bounded time', async () => {
    vi.useFakeTimers();
    try {
      const fetchImage = vi.fn<typeof fetch>(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options!.signal!.addEventListener('abort', () => reject(Error('aborted'))),
          ),
      );
      const pending = expect(retainThumbnail(url, fetchImage)).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(3500);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});
