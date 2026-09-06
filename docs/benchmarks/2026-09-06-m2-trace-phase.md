# Shared GI phase comparison on Apple M2 — 2026-09-06

The incremental and full-maintenance updaters produce identical captured state
and pixels when the GI sampling phase is matched in this controlled courtyard
diagnostic. Advancing the initial GI phase from 5,399 to 5,400 changes the red
wall identically in both updater arms. This resolves the controlled updater
comparison for PR #40. It does not repair dark interiors or establish overall
lighting quality, and cannot establish the exact cause of historical captures
that lack per-image phase and residency records.

## Source and controlled workload

The clean diagnostic source is
`c74ae66929816df6a8271deb74e6fb72c52d13c0`, tree
`2f322918824e318748abf373b0d47de2ff654d30`. Its Core subtree
`2d978dca2fdfafea4dab92670a52665c0fdf58ac` matches the earlier
[performance checkpoint](2026-09-06-m2-trace-maintenance.md).
Neither experiment measures the later integration with main.

One fresh four-cell diagnostic used incremental/full maintenance at initial GI
phases 5,399 and 5,400, with 242 submissions per cell (968 total), the original
83 external courtyard assets and the frozen renderer/workload. It ran on Apple
M2 with headed hardware Chrome 152.0.7977.82. The independently observed
supervisor exit was 0 after 57.297 seconds, inside the original 300-second
deadline. Owned browser and child processes exited normally, device resources
were disposed, and source, executable and asset postflight checks passed.

The independently reviewed
[consumer-integrity contract](../trace-gi-consumer-integrity.md) was frozen before
this run. It observes the actual consumers' reads and verifies EOF, complete
length, SHA256 and normal server completion. Its instrumentation can affect
object lifetime and timing; this is a correctness diagnostic with no timing or
performance-equivalence claim.

## Observed result and limits

Independent audit rehashed all 522 raw artifacts (744,122,336 bytes), decoded
all 12 PNGs against native BGRA readback, checked 51 source files, 11 frozen
artifacts and 83 assets, and recomputed the comparisons. At each initial phase,
all 108 non-write artifacts and the 242-frame semantics match between updaters.
The different write schedules are intentional and retain separate coverage.

| Initial GI phase | Incremental wall mean red | Full wall mean red |
| --- | ---: | ---: |
| 5,399 | 3.42050197 | 3.42050197 |
| 5,400 | 16.80988749 | 16.80988749 |

These are descriptive native-image code values, not a brightness acceptance
threshold. The sky is unchanged. Adjacent surfaces and the ground remain very
dark. The controlled phase effect supports the earlier unmatched-phase
explanation; it does not retroactively reconstruct historical rendering state.

All 332 consumer receipts qualified, and all 339 server requests finished and
closed normally. The raw browser channel still reports **94
`net::ERR_ABORTED` failures**: raw transport remains failed and
`network.admissible` remains false. Each qualifying asset has separate complete
consumer evidence. The result is accepted only as an instrumented
consumer-integrity proof, with no Chrome garbage-collection cause established.
The earlier ffca0d4 diagnostic with 97 failures remains failed under its
original contract; neither it nor the transport-only reproduction is relabeled.

## Retained evidence

Everything below remains local under
`/Users/tyler/Downloads/Strata-Benchmark-Results/`. No assets, raw reports,
generated bundles or captures are committed or uploaded. Reproducing this
historical checkpoint requires the frozen source and plan; the result is not
silently transferable to newer builds.

| Artifact | SHA256 |
| --- | --- |
| `2026-09-06-issue20-consumer-integrity-plan-v1/plan.md` | `218b91b6362a570ea5cb9aec3c43c9d5357e2be5fb870e7f04738f662f8a1d53` |
| `2026-09-06-issue20-consumer-freeze-c74ae66-v1/manifest.json` | `483152ac9bdbf4aaaa50824a209556f0a1e192de351e5f97101350d73e587e44` |
| `2026-09-06-issue20-consumer-hardware-c74ae66-v1/supervisor-report.json` | `7df0134ab3e6df733244340ff8e4999796c425862eab4a711208288d949e519a` |
| `2026-09-06-issue20-consumer-audit-c74ae66-v1/audit.json` | `00ad750abeb15ed77a34713e0782788ce3b36048757d4136864c0ad36164c402` |

The separate root observation is
`2026-09-06-issue20-consumer-execution-c74ae66-v1/execution.json`.
The audit independently reconstructs consumer admission, matches supervisor and
child evidence, and confirms that the invocation's PIDs, groups and temporary
profile tag are absent. CPU admission, raw-network, ownership and comparison
negative controls run through `npm run test:trace-phase:unit`, included in
`npm run check` and CI. The asset/hardware experiment itself stays local.
