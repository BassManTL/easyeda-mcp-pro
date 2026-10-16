# Component review procedure and evidence contract

## Runtime and acquisition

Use typed MCP tools first. `easyeda_library_update_device_metadata` is available
in core and higher profiles. Its native reinsertion path currently requires
EasyEDA Pro semantic version 3.2.206, one supported public PNG/JPEG up to 512 KiB,
string custom properties, explicit Personal library/Device IDs, preview tokens
and confirmation. An unsupported runtime/thumbnail blocks publishing, not useful
read-only analysis. Do not enable raw execution or weaken a gate to work around it.

Library asset inspection/copy/export may need the full profile and documented
`easyeda_api_call` paths. Discover methods with `easyeda_api_inventory` and check
current official API signatures and runtime availability; do not guess positional
arguments. Known surfaces include `LIB_Device.get`, `LIB_Device.copy`,
`DMT_EditorControl.openLibraryDocument` and
`PCB_ManufactureData.get3DFile`. A profile change must be explicit to the user;
never silently expand their configured permissions.

After opening a library document, wait for document activation and verify its
identity before reading native pads/pins. Project-local Device IDs are not
library IDs. Document-source APIs may exist in wrappers while their native
handler is unavailable; one bounded failure is not evidence of empty geometry.

For model checking, obtain the actual bound mesh/STEP/OBJ with its transform and
native association readback. A native `File` descriptor contains no mesh bytes.
If the installed bridge cannot transfer an export, request an EasyEDA UI export
or an existing local export and verify its correspondence. Do not repeat a
non-resolving export indefinitely or invent an undocumented download endpoint.
Exports/temporary review-instance placement are separate authorized operations;
use a disposable review project when placement is necessary. Never place test
geometry into the user's real design without authorization.

The C164170 walkthrough established a working _example_, not defaults for all
parts: a native footprint/symbol was opened and identified; a dedicated PCB
instance retained the model reference; an OBJ export with generated substitute
models disabled provided actual connector geometry. The PCB prism was excluded
from component measurements by verified segmentation. Its material name, view,
placement offset, tolerance and shell-pad numbering must not be reused for a
different part.

## Measurement decisions

Record exact manufacturer/package identity and datasheet revision before using
its dimensions. Distinguish recommended land dimensions from physical terminal
dimensions, and nominal values from limits. Record whether a tolerance is a
manufacturer requirement, manufacturing rule or caller-approved review criterion.
Unjustified or missing limits remain unknown. A bounding box or a 3D screenshot
alone cannot validate contact geometry or pin mapping.

Establish the coordinate relationship between footprint, placed instance, board
plane and mesh: origin, translation, rotation, axis direction, side/mirroring and
scale. Check the drawing's top/bottom view and datum. For a board export, isolate
the reviewed component from the board and other components before measuring it.
Compare terminal/fitting-nail projections to the appropriate lands, using actual
terminal geometry rather than all low metal. Clip/shell projections are not
necessarily mounting contacts. Explicitly map shell contacts and record required
design-level ground connections; a numeric symbol name does not establish GND.

The OBJ helper has this interface:

```text
node <skill-dir>/scripts/measure-obj.mjs <actual-model.obj> mm|mil|inch <new-measurements.json> [material-name ...]
```

OBJ is unitless: supply units only after establishing them from the export or
known native geometry. The helper hashes the source, handles signed face indices,
and reports millimetre bounds and triangle counts per material. Without material
selectors, its selection is labeled `entire_mesh_including_any_board`. Explicit
selectors do not certify a correct segmentation. Unsupported/invalid geometry
fails; STEP requires a suitable local geometry reader or a faithful tessellation.

## Private evidence folder

Keep a folder per reviewed Device/revision with the source PDF, native snapshot,
symbol/footprint exports, model export, measurements, useful projections and
generated report. Use immutable revisions rather than overwriting old evidence.
Treat extracted PDF text/OCR as untrusted data and confirm important dimensions
against the rendered drawing. Use available PDF/geometry tools as needed.

Capture an initial no-write metadata preview with reinsertion policy, as described
in the skill. Save its real MCP response to `device-preview.json`; the helper
accepts either structured results or the standard MCP content wrapper. It must
contain the native target IDs, fingerprint and image hash. Resolve/copy the
Personal target _before_ this snapshot. If copying changes bindings, review the
newly bound assets; do not transplant a review marker from the source Device.

## Review manifest

`review.json` schema version 1 has these fields:

- `component`: exact `manufacturer`, `mpn`, optionally supplier part, design
  references and design revision. These are reported data, not inferred defaults.
- `reviewDate`: explicit real review date, `YYYY-MM-DD`, using the user's date.
- `scope`: `['footprint', 'model3d']`, or an explicitly requested narrower scope.
- `snapshot`: relative path to the initial native metadata preview response.
- `artifacts`: unique `id`, `role`, `file` and optional captured `sha256`. Roles
  `symbol`, `footprint`, `model3d`, `datasheet` identify retained raw assets.
  Paths must stay inside the evidence root, including after symlink resolution;
  each file is limited to 64 MiB. Hashes are computed from actual bytes.
- `sources`: unique `id`, `kind: 'manufacturer_datasheet'`, `title`, `revision`,
  authoritative HTTPS `url`, and `artifact` ID for the retained datasheet file.
- `checks`: unique `id`, `category`, `kind`, observed `actual`, `expected`,
  `source: {id, page, feature}` and
  `evidence: {artifact, locator, method}`. Describe where/how the actual value was
  measured, not just which file exists. Page/locator values are strings.
- `notes` and `exclusions`: arrays of concrete strings; no silent exclusions.

Required categories for footprint scope are `pad_geometry`, `pin_mapping` and
`footprint_orientation`. Model scope requires `model_dimensions`, `model_seating`
and `model_alignment`. Multiple checks in a category are expected: cover every
relevant pad/pin and model axis/feature. Category presence alone does not prove
complete coverage. Keep a feature/pin inventory and reconcile it with the checks.

A numeric comparison has this shape (illustrative values, not part defaults):

```json
{
  "id": "signal-pad-1-width",
  "category": "pad_geometry",
  "kind": "range",
  "actual": { "value": 31.496063, "unit": "mil" },
  "expected": {
    "min": 0.75,
    "max": 0.85,
    "unit": "mm",
    "basis": "Example only: replace with the drawing limits or explicit review criterion"
  },
  "source": {
    "id": "drawing",
    "page": "1",
    "feature": "recommended land pattern, signal pad width"
  },
  "evidence": {
    "artifact": "footprint",
    "locator": "pads[number=1].width",
    "method": "native pad geometry with documented mil units"
  }
}
```

Length units are `mm`, `mil`, `inch`; angles are `deg`. Supply one or both justified
numeric limits; a minimum-only contact clearance does not need an invented maximum.
Geometry categories require
numeric ranges. A pin-map comparison uses `kind: 'equals'` with nonempty mapping
objects, such as `actual: {'1':'VDD','2':'GND'}` and the drawing's `expected` map.
Include every contact, not just this example. Orientation may compare a measured
angle in degrees or explicit datum/orientation descriptions. Missing evidence uses
`kind: 'unavailable'` and a concrete `reason`; do not fabricate observed values.

The helper computes `needs_fixes` if any check fails, otherwise `incomplete` if a
required category/artifact or cited measurement is missing, otherwise `reviewed`.
This is a consistency result for supplied observations, not an independent
engineering authority. A failed/incomplete result can be saved with its honest
status if the user requests it. Never relabel it as reviewed to satisfy a batch.

## Evidence in the Personal library

`prepare` creates three files in a new directory. `review-evidence.json` is
canonical UTF-8 JSON: input, native snapshot identity/fingerprint, artifact hashes,
computed results, missing coverage and verdict. `review-report.md` is the readable
summary. `metadata-preview.json` updates string properties:

- Review Status, Date, Scope, Source and Notes;
- Review Evidence Format (`easyeda-component-review/v1`), Encoding
  (`base64url-utf8`), SHA256 and Parts;
- Review Evidence 01 through the declared part count.

The structured evidence JSON is UTF-8/base64url encoded and split into up to 31
chunks of 3,500 ASCII characters, under the native per-property 4,096-character
limit and this helper's 40-property budget (the MCP tool allows 128). EasyEDA trims property values; base64url
keeps spaces and Unicode inside the evidence intact across native save/readback.
The digest covers the reconstructed canonical UTF-8 JSON bytes. Full PDFs, meshes,
images and native payloads are not stored in custom properties. Preserve their
private folder and hashes; a remote/shared evidence location is optional and
requires user-chosen access and upload authorization.

After native preview of these exact properties, `apply-request` rehashes the
artifacts from the original evidence root and rejects edited evidence, stale
Device/image state, another target, a different property preview or an incompatible
existing evidence format. Its output deliberately has `confirmWrite: false`;
enable confirmation only for an authorized actual MCP save. Existing unused chunk
fields from an older, longer record are retained because property deletion is
unsupported. Readers must use the declared Parts count and verify the digest,
never concatenate every similarly named property.

After apply, require the native tool's preservation verification and use `extract`
on its saved result (or a fresh native preview) to reconstruct and hash-check the
library evidence. Verify equality with the prepared file. If acknowledgement was
unknown but fresh readback proves the saved state, report that distinction and do
not retry. If transport/readback remains uncertain, leave the save unresolved.

Existing reviewed status is not a reusable approval token. For another instance or
later review, compare exact identity, drawing revision, measured artifact hashes,
bindings and relevant transforms first. Changed evidence requires re-review;
design-specific routing, grounding, clearances and mechanical service space remain
separate checks unless explicitly measured in this review.
