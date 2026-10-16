import { describe, expect, it, vi } from 'vitest';
import { requireThumbnailUrl, retainThumbnail } from '../src/device-metadata-thumbnail.js';
const url = 'https://image-pro.easyeda.com/pullimages/abc.jpg';
describe('bounded native thumbnail downloads', () => {
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
