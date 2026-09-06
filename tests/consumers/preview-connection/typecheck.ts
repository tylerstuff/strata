import type { BoxSceneDescriptor, FrameMetrics, SceneCommitReceipt } from '@strata-engine/core';
import { PreviewSession, type AuthoredPreviewView, type PreviewDriver, type PreviewReadyReceipt } from '@strata-engine/preview';
import {
  createPreviewConnection, runPreviewConnectionStdio, PREVIEW_CONNECTION_LIMITS, PREVIEW_CONNECTION_VERSION,
  type ConnectionDiagnostic, type ConnectionResponse, type PreviewConnectionDependencies,
  type PreviewConnectionHandler, type PreviewConnectionObservation, type PreviewConnectionOptions,
  type PreviewConnectionSession,
} from '@strata-engine/preview/connection';

declare const driver: PreviewDriver<BoxSceneDescriptor, AuthoredPreviewView, SceneCommitReceipt, FrameMetrics>;
declare const input: Parameters<typeof runPreviewConnectionStdio>[0]['input'];
declare const output: Parameters<typeof runPreviewConnectionStdio>[0]['output'];
const version: 1 = PREVIEW_CONNECTION_VERSION;
const byteLimit: number = PREVIEW_CONNECTION_LIMITS.inputLineBytes;

async function workflow(projectRoot: string, outputRoot: string, ready: PreviewReadyReceipt<SceneCommitReceipt>): Promise<ConnectionResponse> {
  const controller = new AbortController();
  const options: PreviewConnectionOptions = {
    projectRoot, outputRoot, channel: 'chromium', width: 2, height: 2,
    headless: true, softwareGpu: false, timeoutMs: 1000, cleanupTimeoutMs: 1000, signal: controller.signal,
  };
  const dependencies: PreviewConnectionDependencies = {
    createSession: async startup => {
      const signal: AbortSignal | undefined = startup.signal;
      const actual = new PreviewSession(driver);
      const idle: Promise<void> = actual.whenIdle();
      const session: PreviewConnectionSession = actual;
      const observation: PreviewConnectionObservation = await session.observe();
      await idle;
      await session.whenIdle();
      void signal; void observation;
      return session;
    },
  };
  const connection: PreviewConnectionHandler = await createPreviewConnection(options, dependencies);
  const discovery: ConnectionResponse = await connection.request({ version, id: 1, method: 'discover', params: {} });
  if (!discovery.ok) {
    const diagnostic: ConnectionDiagnostic = discovery.error;
    const requestId: number | null = discovery.id;
    void diagnostic; void requestId;
  } else {
    const requestId: number = discovery.id;
    const result: unknown = discovery.result;
    void requestId; void result;
  }
  const response = await connection.request({ version, id: 2, method: 'capture', params: {
    expectedRevision: ready.sourceRevision, expectedLoadId: ready.loadId,
    expectedViewRevision: ready.viewRevision, captureId: 'typed-connection', frames: 2,
  } });
  await runPreviewConnectionStdio({ connection, input, output, signal: controller.signal, writeTimeoutMs: 1000 });
  const closing: boolean = connection.closing;
  void closing;
  await connection.close();
  return response;
}

// @ts-expect-error A connection needs both fixed roots.
void createPreviewConnection({ projectRoot: '/project' });
// @ts-expect-error Startup dimensions retain the public numeric contract.
const badOptions: PreviewConnectionOptions = { projectRoot: '/project', outputRoot: '/captures', width: '2' };
// @ts-expect-error Successful response IDs are numeric, never strings or null.
const badResponse: ConnectionResponse = { version: 1, id: '1', ok: true, result: {} };
void workflow; void byteLimit; void badOptions; void badResponse;
