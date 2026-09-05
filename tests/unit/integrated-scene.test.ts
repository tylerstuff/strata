import { describe, expect, it } from 'vitest';
import { createIntegratedScene, createIntegratedCamera, integratedScenario, integratedWaypoints } from '../../packages/core/src/integrated/integrated-scene.js';
import { createReflectionScene } from '../../packages/core/src/reflections/reflection-scene.js';
import { giBoxSignedDistance } from '../../packages/core/src/gi/trace-data.js';

describe('integrated courtyard contract', () => {
  it('preserves room/mirror topology and creates an opening above the terrain without changing the separate proof', () => {
    const base = createReflectionScene(); const scene = createIntegratedScene();
    expect(scene.boxes).toHaveLength(13); expect(scene.materials).toHaveLength(6);
    for (let i = 0; i < 13; i++) if (i !== 2) expect(scene.boxes[i]).toEqual(base.boxes[i]);
    expect(scene.boxes[2]!.center[1] + scene.boxes[2]!.halfSize[1]).toBe(0.3);
    expect(base.boxes[2]!.center[1] + base.boxes[2]!.halfSize[1]).toBe(4);
    expect(scene.materials[5]).toMatchObject({ id: 5, albedo: [0.08, 0.65, 0.12], metallic: 0, roughness: 1 });
    expect(createIntegratedScene({}, 'neutral').materials[5]!.albedo).toEqual([0.45, 0.45, 0.45]);
    expect(() => createIntegratedScene({}, 'unknown' as 'green')).toThrow();
  });
  it('records moving geometry and light changes while keeping the tour camera clear of source boxes', () => {
    const poses = new Set<string>();
    for (let frame = 0; frame < 3600; frame++) {
      const time = frame / 60; const controls = integratedScenario(time);
      const scene = createIntegratedScene({ ...controls.gi, ...controls.reflections });
      const camera = createIntegratedCamera(1280, 720, time, [0, 0]);
      expect(camera.viewProjection.every(Number.isFinite)).toBe(true);
      expect(scene.boxes.every(box => giBoxSignedDistance(box, camera.eye) > 0.049)).toBe(true);
      if (time >= 2 && time < 6) poses.add(String(controls.reflections!.objectOffset));
    }
    expect(poses.size).toBeGreaterThan(100);
    expect(integratedScenario(4).gi!.doorOpen).toBe(false); expect(integratedScenario(8).gi!.doorOpen).toBe(true);
    expect(integratedScenario(14).gi!.lightIntensity).toBe(0); expect(integratedScenario(18).gi!.lightIntensity).toBe(1);
    expect(integratedScenario(65)).toEqual(integratedScenario(5));
  });
  it('loops continuously and places the persistent terrain witness outside the diagnostic frustum', () => {
    const first = createIntegratedCamera(1280, 720, 0, [0, 0]);
    const scene = createIntegratedScene(); const emitter = scene.boxes[scene.objectBoxId]!;
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const corner = emitter.center.map((value, axis) => value + [x, y, z][axis]! * emitter.halfSize[axis]!);
      const p = [...corner, 1]; const m = first.viewProjection;
      const clip = Array.from({ length: 4 }, (_, row) => p.reduce((sum, v, col) => sum + v * m[col * 4 + row]!, 0));
      expect(clip[1]).toBeGreaterThan(clip[3]!);
    }
    const end = createIntegratedCamera(1280, 720, 60 - 1e-6, [0, 0]);
    expect(Math.hypot(...first.eye.map((v, i) => v - end.eye[i]!))).toBeLessThan(1e-6);
    const camera = createIntegratedCamera(1280, 720, 0, [0, 0], 'terrain-witness');
    const point = [8, -2.6854204, -3.5, 1]; const m = camera.viewProjection;
    const clip = Array.from({ length: 4 }, (_, row) => point.reduce((sum, v, col) => sum + v * m[col * 4 + row]!, 0));
    expect(clip[3]).toBeGreaterThan(0); expect(Math.abs(clip[1]! / clip[3]!)).toBeGreaterThan(1);
    expect(integratedWaypoints[0]!.time).toBe(0); expect(integratedWaypoints.at(-1)!.time).toBe(60);
  });
});
