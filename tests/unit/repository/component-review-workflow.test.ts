import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const SKILL = join(ROOT, 'skills/easyeda-component-review');
const temporary: string[] = [];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
type Check = {
  id: string;
  category: string;
  kind: string;
  actual: Record<string, unknown>;
  expected: Record<string, unknown>;
  source: { id: string; page: string; feature: string };
  evidence: { artifact: string; locator: string; method: string };
};
type Request = {
  libraryUuid: string;
  deviceUuid: string;
  properties: Record<string, string>;
  mode: string;
  confirmWrite?: boolean;
  expectedFingerprint?: string;
};
function readRequest(path: string): Request {
  return JSON.parse(readFileSync(path, 'utf8')) as Request;
}
function run(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(SKILL, 'scripts', script), ...args], {
    encoding: 'utf8',
  });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'easyeda-component-review-'));
  temporary.push(dir);
  const snapshot = {
    status: 'preview',
    writeOutcome: 'not_attempted',
    libraryUuid: '1'.repeat(32),
    deviceUuid: '2'.repeat(32),
    fingerprintBefore: 'device-v1:sha256:' + 'a'.repeat(64),
    thumbnail: { sha256Before: 'b'.repeat(64) },
  };
  save(join(dir, 'device-preview.json'), { structuredContent: snapshot });
  const rawFiles = {
    'drawing.pdf': 'synthetic drawing fixture',
    'symbol.json': '{"pins":[1,2]}',
    'footprint.json': '{"pads":[1,2]}',
    'model.obj': 'v 0 0 0\nv 1 0 0\nv 0 1 1\nf 1 2 3\n',
  };
  for (const [file, content] of Object.entries(rawFiles)) writeFileSync(join(dir, file), content);
  const categories = [
    'pad_geometry',
    'pin_mapping',
    'footprint_orientation',
    'model_dimensions',
    'model_seating',
    'model_alignment',
  ];
  const checks: Check[] = categories.map((category) => ({
    id: category,
    category,
    kind: 'range',
    actual: { value: 0, unit: 'mm' },
    expected: { min: -0.05, max: 0.05, unit: 'mm', basis: 'synthetic test criterion' },
    source: { id: 'drawing', page: '1', feature: category },
    evidence: {
      artifact: category.startsWith('model') ? 'model' : 'footprint',
      locator: category,
      method: 'synthetic observed measurement',
    },
  }));
  checks[0]!.actual = { value: 31.496063, unit: 'mil' };
  checks[0]!.expected = { min: 0.75, max: 0.85, unit: 'mm', basis: 'synthetic test criterion' };
  checks[1]!.kind = 'equals';
  checks[1]!.actual = { '1': 'VDD', '2': 'GND' };
  checks[1]!.expected = { '1': 'VDD', '2': 'GND' };
  checks[2]!.actual = { value: 0, unit: 'deg' };
  checks[2]!.expected = { min: 0, max: 0, unit: 'deg', basis: 'synthetic datum' };
  const input = {
    schemaVersion: 1,
    component: { manufacturer: 'Synthetic', mpn: 'TEST-2', designReferences: ['J1'] },
    reviewDate: '2026-10-16',
    scope: ['footprint', 'model3d'],
    snapshot: 'device-preview.json',
    artifacts: [
      { id: 'drawing', role: 'datasheet', file: 'drawing.pdf' },
      { id: 'symbol', role: 'symbol', file: 'symbol.json' },
      { id: 'footprint', role: 'footprint', file: 'footprint.json' },
      { id: 'model', role: 'model3d', file: 'model.obj' },
    ],
    sources: [
      {
        id: 'drawing',
        kind: 'manufacturer_datasheet',
        title: 'Synthetic manufacturer drawing',
        revision: 'A',
        url: 'https://example.com/drawing.pdf',
        artifact: 'drawing',
      },
    ],
    checks,
    notes: ['Synthetic fixture only'],
    exclusions: ['Electrical and manufacturing approval'],
  };
  function prepare(name = 'result') {
    save(join(dir, 'review.json'), input);
    const output = join(dir, name);
    const result = run('review.mjs', 'prepare', join(dir, 'review.json'), output);
    return { output, result };
  }
  function preview(output: string) {
    const request = readRequest(join(output, 'metadata-preview.json'));
    const value = {
      ...snapshot,
      requested: { properties: request.properties },
      saved: { properties: {} as Record<string, string> },
    };
    save(join(dir, 'fresh-preview.json'), value);
    return value;
  }
  return { dir, input, snapshot, prepare, preview };
}
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    if (
      dirname(resolve(dir)) !== resolve(tmpdir()) ||
      !basename(dir).startsWith('easyeda-component-review-')
    )
      throw Error('Unsafe test cleanup path');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('component review evidence workflow', () => {
  it('prepares scoped review, binds exact preview without enabling a write, and reconstructs saved Unicode evidence', () => {
    const f = fixture();
    f.input.component.designReferences = ['J1', '🔧'.repeat(5000)];
    const { output, result } = f.prepare();
    expect(result.status, result.stderr).toBe(0);
    const preview = f.preview(output),
      applyFile = join(f.dir, 'apply.json');
    const bind = run(
      'review.mjs',
      'apply-request',
      join(output, 'review-evidence.json'),
      join(f.dir, 'fresh-preview.json'),
      f.dir,
      applyFile,
    );
    expect(bind.status, bind.stderr).toBe(0);
    const apply = readRequest(applyFile);
    expect(apply.confirmWrite).toBe(false);
    expect(apply.expectedFingerprint).toBe(f.snapshot.fingerprintBefore);
    expect(apply.properties['Review Status']).toBe('Reviewed - scoped library checks');
    expect(Object.values(apply.properties).every((value) => value.length <= 4096)).toBe(true);
    const parts = Number(apply.properties['Review Evidence Parts']);
    expect(parts).toBeGreaterThan(2);
    expect(apply.properties['Review Evidence Encoding']).toBe('base64url-utf8');
    for (let i = 1; i <= parts; i++) {
      const part = apply.properties['Review Evidence ' + String(i).padStart(2, '0')]!;
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(part.trim()).toBe(part);
    }
    apply.properties['Review Evidence 32'] = 'unused older chunk';
    save(join(f.dir, 'saved.json'), {
      structuredContent: {
        ...preview,
        status: 'verified',
        saved: {
          properties: Object.fromEntries(
            Object.entries(apply.properties).map(([key, value]) => [key, value.trim()]),
          ),
        },
      },
    });
    const savedFile = join(f.dir, 'saved-evidence.json');
    const extracted = run('review.mjs', 'extract', join(f.dir, 'saved.json'), savedFile);
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(readFileSync(savedFile)).toEqual(readFileSync(join(output, 'review-evidence.json')));
    expect(sha(readFileSync(savedFile))).toBe(apply.properties['Review Evidence SHA256']);
  });
  it('computes failures from actual values rather than a caller-supplied verdict', () => {
    const f = fixture();
    f.input.checks[0]!.actual.value = 100;
    const { output, result } = f.prepare();
    expect(result.status).toBe(0);
    expect(readRequest(join(output, 'metadata-preview.json')).properties['Review Status']).toBe(
      'Needs fixes',
    );
  });
  it('rejects numeric checks substituted for contact mapping', () => {
    const f = fixture();
    f.input.checks[1]!.kind = 'range';
    f.input.checks[1]!.actual = { value: 0, unit: 'mm' };
    f.input.checks[1]!.expected = { min: 0, unit: 'mm', basis: 'Not a pin map' };
    const { result } = f.prepare();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Pin mapping requires');
  });
  it('accepts justified one-sided clearance criteria without inventing an upper bound', () => {
    const f = fixture();
    f.input.checks[5]!.actual = { value: 0.3, unit: 'mm' };
    f.input.checks[5]!.expected = {
      min: 0,
      unit: 'mm',
      basis: 'Nonnegative signed contact containment clearance',
    };
    const { output, result } = f.prepare();
    expect(result.status, result.stderr).toBe(0);
    expect(readRequest(join(output, 'metadata-preview.json')).properties['Review Status']).toBe(
      'Reviewed - scoped library checks',
    );
  });
  it('keeps missing model geometry and coverage incomplete', () => {
    const f = fixture();
    f.input.artifacts = f.input.artifacts.filter((item) => item.role !== 'model3d');
    f.input.checks = f.input.checks.filter((check) => !check.category.startsWith('model'));
    const { output, result } = f.prepare();
    expect(result.status).toBe(0);
    expect(readRequest(join(output, 'metadata-preview.json')).properties['Review Status']).toBe(
      'Incomplete',
    );
    expect(result.stdout).toContain('artifact:model3d');
  });
  it('requires source locations, justified limits and nonempty pin maps', () => {
    const f = fixture();
    f.input.checks[0]!.source.page = '';
    f.input.checks[1]!.expected = {};
    delete f.input.checks[3]!.expected.basis;
    const { output, result } = f.prepare();
    expect(result.status).toBe(0);
    expect(readRequest(join(output, 'metadata-preview.json')).properties['Review Status']).toBe(
      'Incomplete',
    );
  });
  it.each(['unit', 'overflow', 'geometry-equality'])(
    'rejects invalid numeric claims: %s',
    (mode) => {
      const f = fixture();
      const check = f.input.checks[0]!;
      if (mode === 'unit') check.actual.unit = 'pixels';
      if (mode === 'overflow') {
        check.actual.unit = 'inch';
        check.actual.value = Number.MAX_VALUE;
      }
      if (mode === 'geometry-equality') check.kind = 'equals';
      const { output, result } = f.prepare();
      expect(result.status).toBe(1);
      expect(existsSync(output)).toBe(false);
    },
  );
  it.each(['fingerprint', 'thumbnail', 'target', 'plan', 'format', 'artifact'])(
    'rejects stale or mismatched publication: %s',
    (mode) => {
      const f = fixture();
      const { output } = f.prepare();
      const preview = f.preview(output);
      if (mode === 'fingerprint') preview.fingerprintBefore = 'device-v1:sha256:' + 'c'.repeat(64);
      if (mode === 'thumbnail') preview.thumbnail.sha256Before = 'c'.repeat(64);
      if (mode === 'target') preview.deviceUuid = '3'.repeat(32);
      if (mode === 'plan') preview.requested.properties['Review Status'] = 'Unjustified approval';
      if (mode === 'format') preview.saved.properties['Review Evidence Format'] = 'another-format';
      if (mode === 'artifact') writeFileSync(join(f.dir, 'footprint.json'), '{"changed":true}');
      save(join(f.dir, 'fresh-preview.json'), preview);
      const applyFile = join(f.dir, 'apply.json');
      const result = run(
        'review.mjs',
        'apply-request',
        join(output, 'review-evidence.json'),
        join(f.dir, 'fresh-preview.json'),
        f.dir,
        applyFile,
      );
      expect(result.status).toBe(1);
      expect(existsSync(applyFile)).toBe(false);
    },
  );
  it('rejects tampered saved chunks', () => {
    const f = fixture();
    const { output } = f.prepare();
    const preview = f.preview(output);
    preview.saved.properties = {
      ...preview.requested.properties,
      'Review Evidence 01': 'tampered',
    };
    save(join(f.dir, 'saved.json'), preview);
    const result = run(
      'review.mjs',
      'extract',
      join(f.dir, 'saved.json'),
      join(f.dir, 'extracted.json'),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('hash mismatch');
  });
  it('rejects artifact paths outside the evidence root', () => {
    const f = fixture(),
      nested = join(f.dir, 'nested');
    mkdirSync(nested);
    for (const file of [
      'device-preview.json',
      'drawing.pdf',
      'symbol.json',
      'footprint.json',
      'model.obj',
    ])
      copyFileSync(join(f.dir, file), join(nested, file));
    f.input.artifacts[0]!.file = '../drawing.pdf';
    save(join(nested, 'review.json'), f.input);
    const result = run(
      'review.mjs',
      'prepare',
      join(nested, 'review.json'),
      join(nested, 'result'),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('escapes evidence root');
  });
  it('refuses to overwrite an existing review revision', () => {
    const f = fixture();
    const { output } = f.prepare();
    const before = readFileSync(join(output, 'review-evidence.json'));
    expect(f.prepare().result.status).toBe(1);
    expect(readFileSync(join(output, 'review-evidence.json'))).toEqual(before);
  });
});

describe('OBJ review measurements', () => {
  it('handles signed face indices and explicit materials without unused vertices contaminating bounds', () => {
    const f = fixture(),
      file = join(f.dir, 'assembly.obj');
    writeFileSync(
      file,
      'v 0 0 0\nv 100 0 0\nv 0 200 10\nusemtl body\nf 1 2 3\nv -100 -100 -50\nv 1000 -100 -50\nv -100 1000 -50\nusemtl board\nf -3 -2 -1\nv 9999 9999 9999\n',
    );
    const out = join(f.dir, 'body.json'),
      result = run('measure-obj.mjs', file, 'mil', out, 'body');
    expect(result.status, result.stderr).toBe(0);
    const data = JSON.parse(readFileSync(out, 'utf8')) as {
      selection: string;
      bounds: { size: number[] };
      materials: Record<string, unknown>;
    };
    expect(data.selection).toBe('explicit_materials');
    expect(data.bounds.size[0]).toBeCloseTo(2.54);
    expect(data.bounds.size[1]).toBeCloseTo(5.08);
    expect(data.bounds.size[2]).toBeCloseTo(0.254);
    const whole = run('measure-obj.mjs', file, 'mil', join(f.dir, 'assembly.json'));
    expect(whole.status).toBe(0);
    expect(whole.stdout).toContain('entire_mesh_including_any_board');
    expect(run('measure-obj.mjs', file, 'mil', join(f.dir, 'bad.json'), 'missing').status).toBe(1);
  });
  it.each(['v NaN 0 0\nf 1 1 1', 'v 0 0 0\nf 0 1 1', 'v 0 0 0\nf 1 1 2'])(
    'rejects invalid mesh geometry',
    (geometry) => {
      const f = fixture();
      writeFileSync(join(f.dir, 'bad.obj'), geometry);
      expect(
        run('measure-obj.mjs', join(f.dir, 'bad.obj'), 'mm', join(f.dir, 'bad.json')).status,
      ).toBe(1);
    },
  );
});

describe('component review skill discovery', () => {
  it('routes runtime wrappers to the canonical skill and packages it for Claude', () => {
    for (const runtime of ['.agents', '.codex', '.claude', '.opencode']) {
      const content = readFileSync(
        join(ROOT, runtime, 'skills/easyeda-component-review/SKILL.md'),
        'utf8',
      );
      expect(content).toContain('skills/easyeda-component-review/SKILL.md');
    }
    const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8')) as {
      skills: string[];
    };
    expect(manifest.skills).toContain('./skills/easyeda-component-review');
    for (const relative of [
      'SKILL.md',
      'references/review-process.md',
      'scripts/review.mjs',
      'scripts/measure-obj.mjs',
      'agents/openai.yaml',
    ])
      expect(existsSync(join(SKILL, relative))).toBe(true);
  });
});
