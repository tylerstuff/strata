import type { BoxSceneDescriptor } from '@strata-engine/core';
import type { AuthoredPreviewView } from './adapter.js';

/** A saved procedural project; paths are relative to this document's directory. */
export interface ProjectDocument {
  format: 'strata.project';
  version: 1;
  id: string;
  name: string;
  scene: string;
  view: string;
  width: number;
  height: number;
}

/** Exact input hashes distinguish serialization and entity-order changes. */
export interface ProjectIdentity {
  /** Canonical project-document hash, prefixed with sha256:. */
  projectRevision: string;
  /** Existing authoring sceneRevision; collection order is canonicalized there. */
  sourceRevision: string;
  /** Exact bytes, project ID, viewport and lowered-data identity, prefixed with sha256:. */
  inputRevision: string;
  projectSha256: string;
  sceneSha256: string;
  viewSha256: string;
  runtimeSceneSha256: string;
  resolvedViewSha256: string;
}

/** Canonical inputRevision payload, shared by producer and standalone client. */
export interface ProjectInputRevisionPayload extends Pick<ProjectIdentity,
  'projectSha256' | 'sceneSha256' | 'viewSha256' | 'runtimeSceneSha256' | 'resolvedViewSha256'> {
  format: 'strata.project.inputs';
  version: 1;
  projectId: string;
  width: number;
  height: number;
}

export interface ProjectInspection {
  projectPath: string;
  projectRoot: string;
  project: ProjectDocument;
  identity: ProjectIdentity;
  sceneId: string;
  counts: { assets: number; materials: number; entities: number };
  view: AuthoredPreviewView;
  capabilities: { profile: 'opaque-root-boxes'; cooking: false; externalAssets: false };
}

/** The new project manifest was published; late cancellation cannot undo it. */
export interface ProjectInitResult extends ProjectInspection {
  publicationOccurred: true;
  cleanupWarnings?: string[];
}

/** Deployment data contains the Core descriptor, never authoring operations. */
export interface ProjectRuntimeData {
  format: 'strata.project.runtime';
  version: 1;
  projectId: string;
  identity: ProjectIdentity;
  width: number;
  height: number;
  scene: BoxSceneDescriptor;
  view: AuthoredPreviewView;
}

export interface ProjectReadOptions {
  projectPath: string;
  /** Check referenced file existence with authoring's asset diagnostics; never fetch. */
  checkAssets?: boolean;
  assetDirectory?: string;
  signal?: AbortSignal;
}

export interface ProjectInitOptions {
  /** A new directory is created exclusively; existing directories are never replaced. */
  directory: string;
  id: string;
  name?: string;
  signal?: AbortSignal;
}

export interface ProjectBuildOptions extends ProjectReadOptions {
  expectedInputRevision: string;
  /** A new output directory is reserved exclusively; prior builds remain intact. */
  outputDirectory: string;
}

export interface ProjectOutputFile { path: string; bytes: number; sha256: string }

export interface ProjectBuildReceipt {
  format: 'strata.project.build';
  version: 1;
  projectId: string;
  identity: ProjectIdentity;
  width: number;
  height: number;
  runtime: { package: '@strata-engine/core'; version: string; files: ProjectOutputFile[] };
  /** Includes every deployment file except this completion receipt itself. */
  files: ProjectOutputFile[];
}

export interface ProjectBuildResult {
  publicationOccurred: true;
  outputDirectory: string;
  receiptPath: string;
  receipt: ProjectBuildReceipt;
  cleanupWarnings?: string[];
}
