import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const runtimePath = path.resolve('public/assets/models/wally/WallyRuntime.glb');
const exportReportPath = path.resolve('artifacts/wally/wally-runtime-export.json');
const outputPath = path.resolve('artifacts/verification/runtime-asset-check.json');
const expectedMeshNodes = ['CharacterBase', 'LongSleeveShirt', 'Pants'];
const expectedMeshes = ['CharacterMesh', 'LongSleeveShirtMesh', 'PantsMesh'];
const forbiddenPattern = /WallyBrown|WallyDarkHair|WallyHat|WallyRound|WallyRuntimeCane|Fallback/i;

const bytes = await readFile(runtimePath);
const exportReport = JSON.parse(await readFile(exportReportPath, 'utf8'));
const gltf = parseGlbJson(bytes);
const failures = [];
const sha256 = createHash('sha256').update(bytes).digest('hex');
const nodeNames = (gltf.nodes ?? []).map((node) => node.name ?? '');
const meshNames = (gltf.meshes ?? []).map((mesh) => mesh.name ?? '').sort();
const materialNames = (gltf.materials ?? []).map((material) => material.name ?? '');
const animationNames = (gltf.animations ?? []).map((animation) => animation.name ?? '');

if (JSON.stringify(meshNames) !== JSON.stringify([...expectedMeshes].sort())) {
  failures.push(`Expected exactly ${expectedMeshes.join(', ')}, got ${meshNames.join(', ')}.`);
}
const visibleNodeNames = (gltf.nodes ?? [])
  .filter((node) => node.mesh !== undefined)
  .map((node) => node.name ?? '')
  .sort();
if (JSON.stringify(visibleNodeNames) !== JSON.stringify([...expectedMeshNodes].sort())) {
  failures.push(`Expected exactly the three visible nodes, got ${visibleNodeNames.join(', ')}.`);
}
const forbiddenNames = [...nodeNames, ...meshNames, ...materialNames].filter((name) => forbiddenPattern.test(name));
if (forbiddenNames.length > 0) failures.push(`Forbidden extra elements remain: ${forbiddenNames.join(', ')}.`);
if ((gltf.skins?.length ?? 0) !== 1) failures.push(`Expected one CharacterBase skin, got ${gltf.skins?.length ?? 0}.`);
if (animationNames.length !== 1 || exportReport.action !== 'Idle') {
  failures.push(`Expected one animation exported from Idle, got ${animationNames.join(', ')}.`);
}
if (!(gltf.extensionsUsed ?? []).includes('KHR_draco_mesh_compression')) {
  failures.push('Wally runtime GLB is not Draco-compressed.');
}
if (sha256 !== exportReport.output_sha256) failures.push('Public GLB hash differs from the guarded export.');
if (exportReport.source_blend_unchanged !== true) failures.push('Canonical Blender source changed during export.');
if (JSON.stringify(exportReport.mesh_names) !== JSON.stringify(expectedMeshNodes)) {
  failures.push('Guarded export report does not contain the exact three-mesh contract.');
}

let triangles = 0;
for (const mesh of gltf.meshes ?? []) {
  for (const primitive of mesh.primitives ?? []) {
    const accessor = gltf.accessors?.[primitive.indices];
    if (!accessor) failures.push(`${mesh.name} has no indexed triangle accessor.`);
    else triangles += accessor.count / 3;
  }
}
if (triangles !== 5_622) failures.push(`Expected 5,622 triangles, got ${triangles}.`);

const report = {
  generatedAt: new Date().toISOString(),
  pass: failures.length === 0,
  runtimePath,
  bytes: bytes.length,
  sha256,
  sourceBlend: exportReport.source_blend,
  sourceBlendSha256: exportReport.source_blend_sha256_before,
  sourceBlendUnchanged: exportReport.source_blend_unchanged,
  visibleContract: 'CharacterBase + LongSleeveShirt + Pants only',
  nodes: nodeNames,
  visibleNodes: visibleNodeNames,
  meshes: meshNames,
  materials: materialNames,
  skins: gltf.skins?.length ?? 0,
  animations: animationNames,
  triangles,
  forbiddenExtraElements: forbiddenNames,
  failures,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;

function parseGlbJson(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a GLB file.');
  if (buffer.readUInt32LE(4) !== 2) throw new Error('Unsupported GLB version.');
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error('GLB length header is invalid.');
  const jsonLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB JSON chunk is missing.');
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').replace(/\0/g, '').trim());
}
