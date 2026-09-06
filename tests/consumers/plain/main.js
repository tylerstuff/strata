import { createEngine, createMeshAsset, prepareMeshTangents } from '@strata-engine/core';
import { installHarness } from './harness.js';

installHarness(createEngine, createMeshAsset, prepareMeshTangents);
