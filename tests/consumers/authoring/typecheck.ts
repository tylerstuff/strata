import {
  applySceneBatch, createProceduralScene, createScene, createSceneFile, editSceneFile,
  inspectScene, parseBatch, parseScene, previewSceneFile, readSceneFile, sceneRevision,
  serializeScene, validateScene,
  type Result, type SceneBatch, type SceneDocument,
} from '@strata-engine/authoring';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.diagnostics.map(diagnostic => `${diagnostic.path}: ${diagnostic.suggestion}`).join('\n'));
  return result.value;
}

const scene: SceneDocument = createProceduralScene('typed-consumer');
const entity: SceneDocument['entities'][number] = scene.entities[0]!;
const revision: string = sceneRevision(scene);
const batch: SceneBatch = {
  format: 'strata.scene-edit', version: 1, expectedRevision: revision,
  operations: [{ op: 'set-entity', value: { ...entity, transform: { ...entity.transform, position: [4, 0.5, -2] } } }],
};
const preview = unwrap(applySceneBatch(scene, batch));
const changed: boolean = preview.changed;
const next: SceneDocument = unwrap(parseScene(serializeScene(preview.scene), 'typed-consumer.json'));
const validated: SceneDocument = unwrap(validateScene(next));
unwrap(inspectScene(validated, { entityId: entity.id }));
unwrap(inspectScene(validated, { limit: 10, after: entity.id }));
const parsedBatch: SceneBatch = unwrap(parseBatch(JSON.stringify(batch)));

async function fileWorkflow(path: string): Promise<string> {
  const initial = await createSceneFile(path, createScene('typed-file'));
  const snapshot = await readSceneFile(path);
  const edit: SceneBatch = { ...parsedBatch, expectedRevision: snapshot.revision, operations: [] };
  const planned = await previewSceneFile(path, edit);
  const applied = await editSceneFile(path, edit);
  const documents: SceneDocument[] = [initial.scene, snapshot.scene, planned.scene, applied.scene];
  return serializeScene(documents[0]!);
}

void changed;
void fileWorkflow;
