import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const FORMAT = 'easyeda-component-review/v1';
const CHUNK_SIZE = 3500;
const MAX_PARTS = 31;
const GROUPS = {
  footprint: ['pad_geometry', 'pin_mapping', 'footprint_orientation'],
  model3d: ['model_dimensions', 'model_seating', 'model_alignment'],
};
const FACTORS = { mm: 1, mil: 0.0254, inch: 25.4, deg: 1 };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireValue = (ok, message) => {
  if (!ok) throw Error(message);
};
const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort(value[key])]),
    );
  return value;
}
function json(file) {
  requireValue(statSync(file).size <= 2097152, 'JSON input exceeds 2 MiB');
  return JSON.parse(readFileSync(file, 'utf8'));
}
function unwrap(value) {
  return (
    value.structuredContent ??
    (Array.isArray(value.content)
      ? JSON.parse(value.content.find((item) => item.type === 'text').text)
      : value)
  );
}
function fileBytes(root, file) {
  requireValue(
    typeof file === 'string' && file.length > 0 && !isAbsolute(file),
    'Artifact paths must be relative to the evidence root',
  );
  const base = realpathSync(root),
    path = realpathSync(resolve(base, file)),
    rel = relative(base, path);
  requireValue(
    rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel),
    'Artifact escapes evidence root',
  );
  requireValue(
    statSync(path).isFile() && statSync(path).size <= 67108864,
    'Artifact must be a file no larger than 64 MiB',
  );
  return readFileSync(path);
}
function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function snapshot(root, file) {
  const bytes = fileBytes(root, file),
    data = unwrap(JSON.parse(bytes.toString('utf8')));
  requireValue(
    data.status === 'preview' && data.writeOutcome === 'not_attempted',
    'Capture a native no-write metadata preview before reviewing',
  );
  requireValue(
    /^[a-f0-9]{32}$/.test(data.libraryUuid) && /^[a-f0-9]{32}$/.test(data.deviceUuid),
    'Invalid native Device identity',
  );
  requireValue(
    /^device-v1:sha256:[a-f0-9]{64}$/.test(data.fingerprintBefore),
    'Native preview fingerprint required',
  );
  requireValue(
    /^[a-f0-9]{64}$/.test(data.thumbnail?.sha256Before),
    'Native thumbnail preview hash required',
  );
  return {
    file,
    sha256: digest(bytes),
    libraryUuid: data.libraryUuid,
    deviceUuid: data.deviceUuid,
    fingerprint: data.fingerprintBefore,
    thumbnailSha256: data.thumbnail.sha256Before,
  };
}
function artifacts(root, entries) {
  requireValue(Array.isArray(entries), 'artifacts must be an array');
  const ids = new Set();
  return entries.map((entry) => {
    requireValue(
      text(entry.id) && !ids.has(entry.id) && text(entry.role),
      'Artifact IDs must be unique and roles explicit',
    );
    ids.add(entry.id);
    const bytes = fileBytes(root, entry.file),
      sha256 = digest(bytes);
    if (entry.sha256 !== undefined)
      requireValue(entry.sha256 === sha256, 'Captured artifact hash changed: ' + entry.id);
    return { id: entry.id, role: entry.role, file: entry.file, sha256, bytes: bytes.length };
  });
}
function numeric(check) {
  const { actual, expected } = check;
  if (
    !Number.isFinite(actual?.value) ||
    !expected ||
    (expected.min === undefined && expected.max === undefined) ||
    (expected.min !== undefined && !Number.isFinite(expected.min)) ||
    (expected.max !== undefined && !Number.isFinite(expected.max)) ||
    !text(expected?.basis)
  )
    return { status: 'unknown', reason: 'Measured value and justified numeric limits required' };
  requireValue(
    Object.hasOwn(FACTORS, actual.unit) && Object.hasOwn(FACTORS, expected.unit),
    'Unsupported measurement unit',
  );
  requireValue(
    (actual.unit === 'deg') === (expected.unit === 'deg'),
    'Cannot compare angles with lengths',
  );
  requireValue(
    (expected.min ?? -Infinity) <= (expected.max ?? Infinity),
    'Reversed measurement limits',
  );
  const value = actual.value * FACTORS[actual.unit],
    min = expected.min === undefined ? undefined : expected.min * FACTORS[expected.unit],
    max = expected.max === undefined ? undefined : expected.max * FACTORS[expected.unit];
  requireValue(
    [value, min, max].filter((value) => value !== undefined).every(Number.isFinite),
    'Measurement conversion overflow',
  );
  const epsilon =
    Number.EPSILON * 8 * Math.max(1, Math.abs(value), Math.abs(min ?? 0), Math.abs(max ?? 0));
  return {
    status:
      value >= (min ?? -Infinity) - epsilon && value <= (max ?? Infinity) + epsilon
        ? 'pass'
        : 'fail',
    normalized: { value, min, max, unit: expected.unit === 'deg' ? 'deg' : 'mm' },
  };
}
function evaluate(check, artifactList, sources) {
  requireValue(text(check.id) && text(check.category), 'Each check requires an ID and category');
  if (check.kind === 'unavailable')
    return {
      id: check.id,
      category: check.category,
      status: 'unknown',
      reason: check.reason || 'Evidence unavailable',
    };
  requireValue(['range', 'equals'].includes(check.kind), 'Unknown check kind');
  if (check.category === 'pin_mapping')
    requireValue(check.kind === 'equals', 'Pin mapping requires an observed and expected map');
  if (
    ['pad_geometry', 'model_dimensions', 'model_seating', 'model_alignment'].includes(
      check.category,
    )
  )
    requireValue(check.kind === 'range', 'Geometry categories require measured numeric checks');
  if (check.category === 'footprint_orientation' && check.kind === 'range')
    requireValue(check.expected?.unit === 'deg', 'Orientation limits must be in degrees');
  const source = sources.find((item) => item.id === check.source?.id);
  const evidence = artifactList.find((item) => item.id === check.evidence?.artifact);
  if (
    !source ||
    !text(check.source?.page) ||
    !text(check.source?.feature) ||
    !evidence ||
    !text(check.evidence?.locator) ||
    !text(check.evidence?.method)
  )
    return {
      id: check.id,
      category: check.category,
      status: 'unknown',
      reason: 'Traceable datasheet citation and measured-artifact location required',
    };
  let result;
  if (check.kind === 'range') result = numeric(check);
  else if (
    check.actual === undefined ||
    check.expected === undefined ||
    check.actual === null ||
    check.expected === null ||
    (check.category === 'pin_mapping' &&
      (typeof check.expected !== 'object' ||
        Array.isArray(check.expected) ||
        Object.keys(check.expected).length === 0))
  )
    result = { status: 'unknown', reason: 'Both observed and nonempty expected mapping required' };
  else result = { status: canonical(check.actual) === canonical(check.expected) ? 'pass' : 'fail' };
  return { id: check.id, category: check.category, ...result };
}
function validateInput(input) {
  requireValue(input.schemaVersion === 1, 'Unsupported review schema');
  requireValue(
    text(input.component?.manufacturer) && text(input.component?.mpn),
    'Exact manufacturer and MPN required',
  );
  requireValue(
    /^\d{4}-\d{2}-\d{2}$/.test(input.reviewDate) &&
      new Date(input.reviewDate).toISOString().slice(0, 10) === input.reviewDate,
    'Explicit valid review date required',
  );
  requireValue(
    Array.isArray(input.scope) &&
      input.scope.length > 0 &&
      new Set(input.scope).size === input.scope.length &&
      input.scope.every((scope) => Object.hasOwn(GROUPS, scope)),
    'Scope must contain footprint and/or model3d',
  );
  requireValue(
    Array.isArray(input.sources) && Array.isArray(input.checks) && input.checks.length <= 500,
    'Sources and up to 500 checks required',
  );
  requireValue(
    new Set(input.checks.map((check) => check.id)).size === input.checks.length,
    'Check IDs must be unique',
  );
  for (const field of ['notes', 'exclusions'])
    requireValue(
      input[field] === undefined || (Array.isArray(input[field]) && input[field].every(text)),
      field + ' must contain strings',
    );
}
function coverage(input, results, files) {
  const missing = input.scope
    .flatMap((scope) => GROUPS[scope])
    .filter((category) => !results.some((result) => result.category === category));
  if (input.scope.includes('footprint'))
    for (const role of ['symbol', 'footprint'])
      if (!files.some((file) => file.role === role)) missing.push('artifact:' + role);
  if (input.scope.includes('model3d') && !files.some((file) => file.role === 'model3d'))
    missing.push('artifact:model3d');
  if (!input.sources.some((source) => source.kind === 'manufacturer_datasheet'))
    missing.push('manufacturer_datasheet');
  return missing;
}
function build(input, root) {
  validateInput(input);
  const captured = snapshot(root, input.snapshot),
    files = artifacts(root, input.artifacts);
  requireValue(
    new Set(input.sources.map((source) => source.id)).size === input.sources.length,
    'Source IDs must be unique',
  );
  for (const source of input.sources)
    requireValue(
      text(source.id) &&
        text(source.title) &&
        /^https:\/\//.test(source.url) &&
        files.some(
          (file) =>
            file.id === source.artifact &&
            (source.kind !== 'manufacturer_datasheet' || file.role === 'datasheet'),
        ),
      'Each source needs a title, HTTPS URL and retained artifact; manufacturer drawings require datasheet artifacts',
    );
  const results = input.checks.map((check) => evaluate(check, files, input.sources)),
    missing = coverage(input, results, files);
  const status = results.some((result) => result.status === 'fail')
    ? 'needs_fixes'
    : missing.length || results.some((result) => result.status === 'unknown')
      ? 'incomplete'
      : 'reviewed';
  return { format: FORMAT, input, snapshot: captured, artifacts: files, results, missing, status };
}
function properties(bundle) {
  const encoded = Buffer.from(canonical(bundle), 'utf8').toString('base64url'),
    chunks = [];
  for (let start = 0; start < encoded.length;) {
    const end = Math.min(start + CHUNK_SIZE, encoded.length);
    chunks.push(encoded.slice(start, end));
    start = end;
  }
  const count = chunks.length;
  requireValue(
    count > 0 && count <= MAX_PARTS,
    'Structured evidence exceeds 31 library property chunks',
  );
  const result = {
    'Review Status': {
      reviewed: 'Reviewed - scoped library checks',
      needs_fixes: 'Needs fixes',
      incomplete: 'Incomplete',
    }[bundle.status],
    'Review Date': bundle.input.reviewDate,
    'Review Scope': bundle.input.scope.join(', ') + '; only checks recorded in review evidence',
    'Review Source': bundle.input.sources
      .map((source) => source.title + ' ' + (source.revision ?? '') + ' ' + source.url)
      .join('; '),
    'Review Notes': [
      ...(bundle.input.notes ?? []),
      ...(bundle.input.exclusions ?? []).map((note) => 'Excluded: ' + note),
    ].join('; '),
    'Review Evidence Format': FORMAT,
    'Review Evidence Encoding': 'base64url-utf8',
    'Review Evidence SHA256': digest(canonical(bundle)),
    'Review Evidence Parts': String(count),
  };
  for (let i = 0; i < count; i++)
    result['Review Evidence ' + String(i + 1).padStart(2, '0')] = chunks[i];
  for (const [key, value] of Object.entries(result))
    requireValue(
      typeof value === 'string' && value.length <= 4096,
      'Library property exceeds 4096 characters: ' + key,
    );
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.trim()]));
}
function previewRequest(bundle) {
  return {
    libraryUuid: bundle.snapshot.libraryUuid,
    deviceUuid: bundle.snapshot.deviceUuid,
    mode: 'preview',
    thumbnailPolicy: 'reinsert-existing',
    properties: properties(bundle),
  };
}
function markdown(bundle) {
  const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows = bundle.results.map(
    (result) =>
      `| ${escape(result.id)} | ${escape(result.category)} | ${result.status} | ${escape(result.reason ?? canonical(result.normalized ?? {}))} |`,
  );
  return `# ${bundle.input.component.manufacturer} ${bundle.input.component.mpn}\n\nStatus: **${bundle.status}**\nDate: ${bundle.input.reviewDate}\nScope: ${bundle.input.scope.join(', ')}\nEvidence SHA-256: ${digest(canonical(bundle))}\n\n| Check | Category | Result | Measurement / finding |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\nMissing: ${bundle.missing.join(', ') || 'none'}\n\nNotes: ${(bundle.input.notes ?? []).join('; ')}\n\nExcluded: ${(bundle.input.exclusions ?? []).join('; ') || 'none stated'}\n\nScoped library review only; not electrical, manufacturing or assembly approval. Full citations, observed/expected values and artifact hashes are in review-evidence.json and the library evidence properties.\n`;
}
function newFile(path, content) {
  requireValue(!existsSync(path), 'Refusing to overwrite existing output: ' + path);
  writeFileSync(path, content, { flag: 'wx' });
}
function prepare(inputPath, output) {
  const bundle = build(json(inputPath), dirname(resolve(inputPath))),
    request = previewRequest(bundle),
    report = markdown(bundle);
  requireValue(!existsSync(output), 'Use a new output directory for each review revision');
  mkdirSync(output, { recursive: true });
  newFile(resolve(output, 'review-evidence.json'), canonical(bundle));
  newFile(resolve(output, 'review-report.md'), report);
  newFile(resolve(output, 'metadata-preview.json'), JSON.stringify(request, null, 2));
  return {
    status: bundle.status,
    evidenceSha256: digest(canonical(bundle)),
    missing: bundle.missing,
    output,
  };
}
function bind(evidencePath, previewPath, root, output) {
  const bundle = json(evidencePath),
    rebuilt = build(bundle.input, root),
    preview = unwrap(json(previewPath));
  requireValue(
    canonical(bundle) === canonical(rebuilt),
    'Evidence or captured artifacts changed; rerun the affected review checks',
  );
  requireValue(
    preview.status === 'preview' && preview.writeOutcome === 'not_attempted',
    'Fresh successful native preview required',
  );
  requireValue(
    preview.libraryUuid === bundle.snapshot.libraryUuid &&
      preview.deviceUuid === bundle.snapshot.deviceUuid,
    'Preview targets a different Device',
  );
  requireValue(
    preview.fingerprintBefore === bundle.snapshot.fingerprint &&
      preview.thumbnail?.sha256Before === bundle.snapshot.thumbnailSha256,
    'Device or thumbnail changed during review; recheck the bound assets before publishing',
  );
  requireValue(
    canonical(preview.requested?.properties) === canonical(properties(bundle)),
    'Fresh preview must cover these exact review properties',
  );
  const existingFormat = preview.saved?.properties?.['Review Evidence Format'];
  requireValue(
    existingFormat === undefined || existingFormat === FORMAT,
    'Existing evidence uses another format; explicit migration required',
  );
  const request = {
    ...previewRequest(bundle),
    mode: 'apply',
    confirmWrite: false,
    expectedFingerprint: preview.fingerprintBefore,
    expectedThumbnailSha256: preview.thumbnail.sha256Before,
  };
  newFile(output, JSON.stringify(request, null, 2));
  return { status: bundle.status, confirmWrite: false, output };
}
function extract(resultPath, output) {
  const record = unwrap(json(resultPath)),
    props = record.saved?.properties;
  requireValue(
    props?.['Review Evidence Format'] === FORMAT,
    'Recognized library evidence format required',
  );
  requireValue(
    props['Review Evidence Encoding'] === 'base64url-utf8',
    'Recognized library evidence encoding required',
  );
  const countText = props['Review Evidence Parts'];
  requireValue(
    typeof countText === 'string' && /^(?:[1-9]|[12][0-9]|3[01])$/.test(countText),
    'Invalid evidence part count',
  );
  let encoded = '';
  for (let i = 1; i <= Number(countText); i++) {
    const part = props['Review Evidence ' + String(i).padStart(2, '0')];
    requireValue(
      typeof part === 'string' && part.length <= CHUNK_SIZE && /^[A-Za-z0-9_-]+$/.test(part),
      'Missing or oversized evidence part',
    );
    encoded += part;
  }
  const bytes = Buffer.from(encoded, 'base64url');
  requireValue(bytes.toString('base64url') === encoded, 'Invalid saved evidence encoding');
  requireValue(digest(bytes) === props['Review Evidence SHA256'], 'Saved evidence hash mismatch');
  const decoded = bytes.toString('utf8'),
    bundle = JSON.parse(decoded);
  requireValue(canonical(bundle) === decoded, 'Saved evidence must be canonical UTF-8 JSON');
  requireValue(
    bundle.format === FORMAT &&
      bundle.snapshot.libraryUuid === record.libraryUuid &&
      bundle.snapshot.deviceUuid === record.deviceUuid,
    'Saved evidence belongs to another Device',
  );
  requireValue(
    properties(bundle)['Review Status'] === props['Review Status'],
    'Saved review status disagrees with evidence',
  );
  newFile(output, bytes);
  return { status: bundle.status, evidenceSha256: digest(bytes), output };
}

try {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'prepare' && args.length === 2) result = prepare(...args);
  else if (command === 'apply-request' && args.length === 4) result = bind(...args);
  else if (command === 'extract' && args.length === 2) result = extract(...args);
  else
    throw Error(
      'Usage: node review.mjs prepare INPUT.json NEW_OUTPUT_DIR | apply-request EVIDENCE.json PREVIEW.json ARTIFACT_ROOT NEW_OUTPUT.json | extract MCP_READBACK.json NEW_OUTPUT.json',
    );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
