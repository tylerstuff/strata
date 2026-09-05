# Local benchmark assets

The Sketchfab test collection is for local testing and benchmarking only. Keep its models, textures, ZIP archives, converted/derived assets, and cooked copies outside this repository. Do not upload those files to GitHub, Git LFS, releases, or CI artifacts.

The current local collection is at `~/Downloads/Strata-Benchmark-Assets`. Read its `README.md` and `catalog.json` for recommended glTF entry points, attribution, validation results, and known conversion/material limitations. Always use the catalog's recommended entries, including normalized animation inputs. Do not treat asset conformance results as renderer support or performance evidence.

Future benchmark tooling must accept a configurable external local asset directory. Its asset server and cooker should read from and write to that external location instead of copying the collection into repository fixtures or build output. CI should use small procedural fixtures; it must not fetch or upload this collection. Keep attribution and provenance alongside the external asset files.

The optional [local gallery](gallery.md), tracked in GitHub issue #33, reads this catalog in place and reports unsupported content explicitly. Its generated CI fixtures do not contain collection data. GitHub issue #2 tracks the benchmark harness and this storage requirement.
