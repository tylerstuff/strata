import { createProceduralScene, sceneRevision, type SceneDocument } from '@strata-engine/authoring';
import type { AuthoredFrameMetadata, BoxSceneDescriptor, FrameMetrics, SceneCommitReceipt } from '@strata-engine/core';
import {
  PreviewError, PreviewSession, createPreviewSession, prepareAuthoredPreviewLoad, publishCapture,
  type AuthoredPreviewLoadInput, type AuthoredPreviewView,
  type CaptureRequest, type OperationOptions, type PreparedPreviewLoad,
  type PreviewDriver, type PreviewDriverFrame, type PreviewDriverObservation, type PreviewReadyReceipt,
} from '@strata-engine/preview';

interface CpuView { source: 'cpu-fixture'; deterministicSetting: string }
interface CpuCommit { generation: number; source: 'cpu-fixture'; sourceRevision: string }
interface CpuFrame { frameId: number; source: 'cpu-fixture' }
declare const driver: PreviewDriver<SceneDocument, CpuView, CpuCommit, CpuFrame>;
const session = new PreviewSession(driver, { defaultTimeoutMs: 1000, cleanupTimeoutMs: 1000 });

async function workflow(outputDirectory: string): Promise<string> {
  const scene = createProceduralScene('typed-preview');
  const prepared: PreparedPreviewLoad<SceneDocument, CpuView> = {
    scene, sceneId: scene.id, sourceRevision: sceneRevision(scene),
    view: { source: 'cpu-fixture', deterministicSetting: 'fixed' },
  };
  const controller = new AbortController();
  const operation: OperationOptions = { signal: controller.signal, timeoutMs: 1000 };
  const ready: PreviewReadyReceipt<CpuCommit> = await session.load(prepared, operation);
  const observation: PreviewDriverObservation<CpuCommit> = await driver.observe();
  const frame: PreviewDriverFrame<CpuCommit, CpuFrame> = await driver.render(prepared.view, controller.signal);
  const request: CaptureRequest = {
    outputDirectory, captureId: 'typed-capture', frames: 2,
    expectedRevision: ready.sourceRevision, expectedLoadId: ready.loadId, expectedViewRevision: ready.viewRevision,
  };
  const capture = await session.capture(request, operation);
  const paths: string[] = [capture.imagePath, capture.receiptPath];
  const receipt: unknown = capture.receipt;
  const afterResize: PreviewReadyReceipt<CpuCommit> = await session.resize(2, 1, operation);
  const publicError = new PreviewError('PREVIEW_TEST', 'typed-consumer', 'typed failure', { committedReceipt: afterResize.commit });
  // @ts-expect-error Capture requires all source/load/view identity tokens.
  void session.capture({ outputDirectory });
  // @ts-expect-error Physical viewport dimensions are numbers.
  void session.resize('2', 1);
  await session.dispose();
  void observation;
  void frame;
  void receipt;
  void publicError;
  return paths[0]!;
}

async function artifactTypes(png: Uint8Array, outputDirectory: string): Promise<unknown> {
  return publishCapture({
    outputDirectory, captureId: 'typed-artifact', png,
    createReceipt: image => ({ format: 'consumer.fixture', version: 1, width: image.width, image }),
    commit: async publish => publish(),
  });
}

void workflow;
void artifactTypes;

function runtimeAdapterTypes(scene: SceneDocument): BoxSceneDescriptor {
  const source: AuthoredPreviewLoadInput = {
    scene, revision: sceneRevision(scene), view: {
      camera: { position: [0, 1, 3], rotation: [0, 0, 0, 1], projection: { kind: 'perspective', verticalFovRadians: Math.PI / 3, near: 0.1, far: 100 } },
      light: { directionToLight: [0, 1, 0], radiance: [2, 2, 2] }, background: [0, 0, 0],
    },
  };
  const prepared: PreparedPreviewLoad<BoxSceneDescriptor, AuthoredPreviewView> = prepareAuthoredPreviewLoad(source);
  const camera: BoxSceneDescriptor['camera'] = prepared.view.camera;
  void camera;
  return prepared.scene;
}

void runtimeAdapterTypes;

const factory: (options?: Parameters<typeof createPreviewSession>[0]) => Promise<PreviewSession<BoxSceneDescriptor, AuthoredPreviewView, SceneCommitReceipt, FrameMetrics>> = createPreviewSession;
void factory;

function authoredMotionTypes(frame: PreviewDriverFrame<SceneCommitReceipt, FrameMetrics>): void {
  if (!frame.metrics.authored) return;
  const motion: AuthoredFrameMetadata['motion'] = frame.metrics.authored.motion;
  const previousSubmittedFrameId: number | null = motion.previousSubmittedFrameId;
  const valid: boolean = motion.valid;
  const resetReason: 'first-frame' | 'camera-cut' | 'viewport-change' | null = motion.resetReason;
  void [previousSubmittedFrameId, valid, resetReason];
}
void authoredMotionTypes;
