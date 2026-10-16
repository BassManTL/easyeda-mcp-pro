import type { DeviceMetadataInput } from './device-metadata-input.js';

const MAX_BYTES = 524288;
export interface RetainedThumbnail {
  url: string;
  sha256: string;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: 'image/png' | 'image/jpeg';
  blob: Blob;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function requireThumbnailUrl(value: unknown): string {
  if (typeof value !== 'string')
    fail('THUMBNAIL_URL_UNSUPPORTED', 'Native thumbnail URL is missing.');
  // The editor can shadow the global URL constructor. Match the entire narrow
  // supported URL grammar instead; percent escapes, ports and suffix hosts fail.
  const allowed =
    /^https:\/\/image-pro\.easyeda\.com\/pullimages\/[a-f0-9]+\.(?:jpg|jpeg|png)$/i.test(value) ||
    /^https:\/\/alimg\.szlcsc\.com\/upload\/public\/product\/(?:big|middle|small)\/[a-z0-9/_-]+\.(?:jpg|jpeg|png)$/i.test(
      value,
    );
  if (!allowed)
    fail(
      'THUMBNAIL_URL_UNSUPPORTED',
      'Only supported HTTPS EasyEDA/LCSC thumbnail paths are accepted; no credentials, redirects, query strings or arbitrary hosts.',
    );
  return value;
}

export function singleThumbnailUrl(record: Record<string, unknown>): string {
  const images = (record.association as Record<string, unknown>).images;
  if (!Array.isArray(images) || images.length !== 1)
    fail(
      'THUMBNAIL_LAYOUT_UNSUPPORTED',
      'Reinsertion currently requires exactly one existing thumbnail.',
    );
  return requireThumbnailUrl(images[0]);
}

export function requireReinsertionMetadata(
  input: DeviceMetadataInput,
  record: Record<string, unknown>,
): void {
  const existing = ((record.property as Record<string, unknown>).otherProperty ?? {}) as Record<
    string,
    unknown
  >;
  if (
    Object.values({ ...existing, ...input.properties }).some((value) => typeof value !== 'string')
  )
    fail(
      'PROPERTY_TYPE_UNSUPPORTED',
      'Existing and requested custom values must be strings; this runtime coerces numeric/boolean values.',
    );
}

async function readBounded(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_BYTES) fail('THUMBNAIL_TOO_LARGE', 'Thumbnail exceeds 512 KiB.');
  const reader = response.body?.getReader();
  if (!reader) fail('THUMBNAIL_DOWNLOAD_FAILED', 'Thumbnail response has no readable body.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) fail('THUMBNAIL_TOO_LARGE', 'Thumbnail exceeds 512 KiB.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function imageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte))
    return 'image/png';
  if ([255, 216, 255].every((byte, index) => bytes[index] === byte)) return 'image/jpeg';
  return fail('THUMBNAIL_FORMAT_UNSUPPORTED', 'Only PNG/JPEG image signatures are supported.');
}

export async function retainThumbnail(
  url: string,
  fetchImage: typeof fetch = globalThis.fetch,
): Promise<RetainedThumbnail> {
  url = requireThumbnailUrl(url);
  if (typeof fetchImage !== 'function')
    fail('THUMBNAIL_DOWNLOAD_FAILED', 'Image download capability is unavailable.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetchImage(url, {
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    if (!response.ok || response.redirected)
      fail('THUMBNAIL_DOWNLOAD_FAILED', 'Thumbnail request failed or redirected.');
    const bytes = await readBounded(response);
    const mimeType = imageMime(bytes);
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { url, bytes, mimeType, sha256, blob: new Blob([bytes], { type: mimeType }) };
  } finally {
    clearTimeout(timer);
  }
}
