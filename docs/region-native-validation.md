# Region initialization native validation

This standalone diagnostic prepares the restricted [issue #18](https://github.com/tylerstuff/strata/issues/18) native correctness gate for [bounded region initialization](region-initialization.md). Its presence does not establish a hardware result. The implementation and its CPU validation are frozen separately in [draft PR #45](https://github.com/tylerstuff/strata/pull/45).

## CPU preparation

Commit the reviewed harness source and build the package before preparing a fresh evidence directory outside Git:

```sh
npm run build
npm run test:geometry:regions -- --prepare-only --output /absolute/external/fresh-preparation
```

Preparation imports no Playwright, launches no browser and requests no adapter. It uses the unchanged procedural cooker for seeds 51–54, checks their exact manifest and page hashes against the earlier CPU proof, then removes the temporary cooked files. It stores the canonical plan, browser bundle, source inputs, all built Core files, Chrome executable/version identity and before/after receipts. It rejects dirty source, missing package files, unsafe output paths and input drift. The evidence contains no cooked asset payloads or external benchmark collection.

Focused CPU controls are separate from native execution:

```sh
npx vitest run tests/unit/region-native-preparation.test.ts
node --test scripts/test-region-initialization.test.mjs
```

## Bounded native gate

Native execution requires `--prepared /absolute/external/frozen-preparation` and a different fresh `--output` directory. It recooks and verifies the frozen source, package, browser, bundle and plan before importing Playwright. The required environment is `STRATA_TEST_BROWSER_CHANNEL=chrome`, `STRATA_TEST_HEADED=1`, and `STRATA_TEST_SOFTWARE_GPU=0`; the adapter must be non-fallback Apple Metal. There is no automatic retry or browser installation.

Run this only inside the coordinator's allocated GPU window using its separately frozen process watchdog. That watchdog starts the new diagnostic, then the four existing `test:geometry` scripts and packed-consumer validation as six direct Node children in total. One clock covers the entire sequence and cleanup: stop at the first failure or 575 seconds, force owned-process cleanup at 590 seconds, and end by 600 seconds. The diagnostic itself permits at most 600 coordinator advances, 60 seconds per initialization stage and 180 seconds in its browser entry point. This diagnostic is not added to the ordinary aggregate command.

The four sources pass through two live coordinator slots. A controlled A→B→A sequence holds the first two original manifest fetch/cancellation lifetimes after abort; three advances must keep fresh A queued and retain the original entry, request and metadata charges. After actual settlement, fresh A becomes ready alone before the desired set expands. Explicit host retirement of the first ready pair makes room for the second pair. The controlled holds provide lifetime evidence, not network latency measurements.

Exactly eight direct render submissions compare four sequential eager references with four actual coordinator-owned providers. Each submission contains one command buffer and produces a 256×256 final-color/depth readback using the existing coverage camera, time zero, a camera cut and temporal rendering disabled. The total is 24 draws and 16 dispatches. Source-derived coarse feedback must report 128 camera and 128 shadow triangles, four camera/shadow clusters and four visible tiles, with exact submission IDs and no missing coverage or overflow. First-frame returned triangle statistics still describe preceding feedback.

The frozen image gates require equal coverage masks, at most one 8-bit color-channel difference, depth difference at most `2e-6`, finite depths in `[0,1]`, opaque pixels, background corner depth 1, and all 55,696 samples in the three-pixel terrain-interior inset covered. The four eager references must have distinct depth hashes. The harness uses existing depth-copy support and an owned presentation texture; it changes no production resource usage.

Successful coordinator initialization must account for exactly 267,040 accepted queue-write bytes, at most 65,536 per host advance, with no writes between advances. Separate corrupted seed-54 manifest/root routes must fail without publishing a provider or uploading a corrupt root. Optional detail requests fail the proof. Queue hashes describe copied CPU arguments accepted by native `writeBuffer` calls; submission feedback and texture readbacks provide execution evidence.

The test-only structural borrow of a ready provider matches its ID and incarnation inside the coordinator's private live set. Each renderer stays alive until coordinator retirement and actual provider settlement, then disposes idempotently. No public accessor or ownership-transfer API is introduced, and the harness remains outside runtime bundles. Success requires empty original-operation sets, zero logical leases and route handlers before runner cleanup, exactly-once native destruction, clean GPU scopes and independently closed browser/context/server resources. Forced cleanup or uncertain process ownership fails the result.

This proves isolated initialization and retirement only. It does not compose a world, apply region placement, validate pending-feedback disposal overlap on hardware, establish temporal quality or performance, or complete issue #18. Pending-feedback disposal overlap remains covered by the separate CPU settlement tests.
