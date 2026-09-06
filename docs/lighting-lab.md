# Colored light transport lab

Run `npm run gallery` and open `/lighting-lab/index.html` on the local server. This generated example needs no downloaded assets. It uses the public Core API and the existing single-material, static progressive imported GI profile, with a neutral room, a pedestal, and an emissive texture palette. Red/blue and green/magenta panels illuminate nearby neutral surfaces through traced transport; red-only and blue-only variants isolate the sources.

The direct-only toggle preserves visible emitters but removes bounced color. The blocked-panels variant inserts opaque walls between both emitters and the room. It should be dark, demonstrating scene visibility rather than unrestricted colored ambient fill. There is no directional or ambient illumination in this fixture.

The preview is explicitly 320×180, up to 512 samples per pixel, spatial denoising, and progressive accumulation. It fences each update and stops after a bounded settling window; this scheduling is for inspection, not real-time GI or a navigation benchmark. Noise and spatial filtering artifacts remain. It does not add general point lights, shadowed spotlights, multiple diffuse bounces or full-Bistro GI.

`npm run test:lighting-lab` renders red/blue, green/magenta, direct-only and blocked cases, checks an emitter-free receiving patch and GPU errors, and stores generated screenshots/reports outside the repository. Full `npm run check` includes this test. The example and immutable-shadow optimization are tracked in issue #59.

Initial M2/Chrome validation observed two invalid trace attempts out of about 23.6 million, no traversal exhaustion, and 30 primary-guide bypass pixels. These remain a numerical edge-case investigation under #59; the color/occlusion assertions do not certify every trace sample. The pedestal front also remains dark in this one-bounce fixture.
