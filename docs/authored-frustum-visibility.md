# Resident authored frustum selection prerequisite

This CPU-only prerequisite is tracked in [issue #18](https://github.com/tylerstuff/strata/issues/18#issuecomment-5552767808). The renderer does **not** call it. It changes no shader, public metadata, scene schema, buffer upload, draw, submitted-frame history, or preview behavior. No GPU validation or performance result is claimed.

`selectAuthoredBoxVisibility` consumes the complete current `modelMatrices` and `viewProjection` produced by the existing coordinate packer, after existing scene and effective-camera validation. It is not an alternative validator. The 0–1024 resident-box limit, complete ±4096-metre camera-relative bounds, source-coordinate guard and all dimension/lens limits remain unchanged, including for offscreen roots. Malformed packed buffer shapes/counts throw an internal range error. Numeric values outside the separate [enclosure proof domain](authored-frustum-enclosure.md) retain their root; they do not make an otherwise admitted scene unsupported.

For every supported root the selector tests the six homogeneous inside expressions `x+w`, `w-x`, `y+w`, `w-y`, `z`, `w-z`. It rejects only if every one of the eight enclosed cube corners has a strictly negative upper bound for a common plane. The host plane sums/differences are rounded outward in binary64. It never divides by W, removes a box merely because no corner is inside, or discards a zero-touching bound. Convex combinations of vertices outside a common halfspace remain outside; whole-triangle clipping is the independent oracle rather than this production support test.

The output contains original scene-slot indices and ascending contiguous draw ranges. Neither the pack nor any source identity is rewritten. At most 16 separate ranges are returned: more fragmented retained slots fall back to the full resident range, with an explicit `run-limit` reason. Classification rejections remain reported even when that fallback draws the classified-outside roots. The internal `none` mode bypasses the enclosure and returns the complete ordered range for comparison. Neither mode bypasses the caller's scene admission checks.

## Diagnostic semantics

All diagnostics belong to this internal prerequisite and its CPU tests; they are not added to `FrameMetrics.authored` or the preview view hash.

| Field | Meaning |
| --- | --- |
| `candidateBoxes` | Complete resident count N. |
| `testedBoxes` | N in frustum mode, zero in forced-all mode; unsupported arithmetic still counts as an attempted box test. |
| `planeTests` | Actually evaluated root/plane tests, each considering eight corners; excludes unsupported boxes. |
| `rejectedBoxes` | Roots with a certified common outside plane, before range fallback. |
| `uncertainRetainedBoxes` | Retained roots without a strict whole-box-inside certificate, including intersecting/boundary and unsupported roots. This is not solely a floating-point ambiguity count. |
| `unsupportedRetainedBoxes` | Subset retained because the arithmetic enclosure is unavailable. |
| `retainedBoxes` / `drawnBoxes` | Classifier survivors / planned submitted instances after conservative fallback. Neither means pixel-visible. |
| `skippedBoxes` | N minus planned drawn instances; can be zero despite classifier rejections. |
| `drawCalls` / `drawnTriangles` | Planned ranges / 12 times planned drawn instances. |
| `packedInstances` | Full N; no transform packing reduction. |
| `currentModelUploadBytes` / `previousModelUploadBytes` | Planned full uploads of 64N bytes each, including culled roots. |
| `frameUniformUploadBytes` / `totalUploadBytes` | 176 / 128N+176 bytes for nonempty residency, zero for empty residency. These are a preservation contract, not measured queue traffic. |

The selector is pure and retains no previous visibility/camera state. Returned selection arrays, ranges and diagnostics are frozen snapshots. It neither owns GPU resources nor modifies the packed inputs. The cost is a bounded linear CPU pass with eight corner enclosures per root and ordered range construction. No upload reduction, memory reduction, frame-time improvement, streaming, hierarchy, GPU visibility system or occlusion culling follows from these counts.

## Independent acceptance and remaining integration gate

The CPU reference interprets binary floating-point words as exact rationals and clips all 12 unit-box triangles against the homogeneous clip volume. It does not call the enclosure or repeat its same-plane support predicate. Fixed 90-degree near=1/far=2 cases independently establish plane signs from camera-forward depth; tests include boundary contacts and slivers, surfaces crossing the frustum without an inside corner, nonvacuous separated roots, and signed/mixed large offsets and actual derived-cell crossings. Exact equivalent dyadic packed scenes must retain the same slots. Fixed center-only, too-small geometry and early-global-f32 controls must lose a reference witness rather than redefine it. Separate arithmetic tests exercise directed rounding and cross-stage expression regrouping against the enclosure.

The selector tests cover ordered runs, the 16/17-run boundary and full fallback, 1024/1025 resident counts, empty versus all-culled residency, unsupported arithmetic, forced-all selection, immutable inputs and repeat selection through invisible/re-entered camera packs. Existing authored validation still rejects invalid offscreen roots and invalid camera-relative overrides. These tests do not simulate or claim actual GPU submissions.

Before eventual renderer integration, review the enclosure proof and frozen CPU source/tests independently. Integration must retain complete scene-order current/prior model uploads and static material/normal slots; ascending `firstInstance` ranges preserve equal-depth draw order. Even an all-culled nonempty scene must clear color/depth/motion targets, stage the full current pack and acknowledge history only after successful submission. Re-entry must use the immediately preceding submitted camera/origin/lens, never the last frame in which the root was drawn. Visibility alone must not trigger a motion reset. Existing canceled/failed partial upload, finish/submit, cut/resize, scene replacement and interleaved-renderer rules remain mandatory.

A separately scheduled future GPU gate must compare culling versus forced-all on independent but identically driven renderer histories. Require complete color/depth/motion equality, including clip-boundary pixels and slivers, without shrinking the denominator to eroded interiors. Preserve existing independent coordinate/depth/PBR/motion gates. Add deliberately false-culled-visible-root and wrong-prior-slot controls at integration, and test successful all-culled submissions plus cut/resize/failure/re-entry sequences. No renderer enabling or GPU run is authorized by completion of this prerequisite alone.
