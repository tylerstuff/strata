import { createEngine, createMeshAsset } from '@strata-engine/core';
import { installHarness } from './harness.js';

installHarness(createEngine, createMeshAsset);
