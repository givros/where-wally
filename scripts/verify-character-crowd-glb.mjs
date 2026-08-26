import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const runtimePath = path.resolve('public/assets/models/crowd/CharacterCrowdRuntime.glb');
const exportReportPath = path.resolve('artifacts/crowd/CharacterCrowdRuntime_export.json');
const outputPath = path.resolve('artifacts/verification/runtime-crowd-asset-check.json');
const expectedNodes = [
  'CrowdBodyHigh',
  'CrowdShirtHigh',
  'CrowdPantsHigh',
  'CrowdBodyMedium',
  'CrowdShirtMedium',
  'CrowdPantsMedium',
  'CrowdBodyLow',
  'CrowdShirtLow',
  'CrowdPantsLow',
];

const bytes = await readFile(runtimePath);
const exportReport = JSON.parse(await readFile(exportReportPath, 'utf8'));
const gltf = parseGlbJson(bytes);
const failures = [];
const sha256 = createHash('sha256').update(bytes).digest('hex');
const nodeNames = (gltf.nodes ?? []).map((node) => node.name);
const meshNames = (gltf.meshes ?? []).map((mesh) => mesh.name);
const materialNames = (gltf.materials ?? []).map((material) => material.name);

if (JSON.stringify(nodeNames) !== JSON.stringify(expectedNodes)) {
  failures.push(`Expected exactly the nine CharacterBase LOD nodes, got ${nodeNames.join(', ')}.`);
}
if ((gltf.skins?.length ?? 0) !== 0) failures.push('Runtime crowd GLB contains skins.');
if ((gltf.animations?.length ?? 0) !== 0) failures.push('Runtime crowd GLB contains animations.');
if (!(gltf.extensionsUsed ?? []).includes('KHR_draco_mesh_compression')) {
  failures.push('Runtime crowd GLB is not Draco-compressed.');
}
if (sha256 !== exportReport.output_sha256) failures.push('Public GLB hash differs from the guarded export.');
if (exportReport.source_blend_unchanged !== true) failures.push('Canonical Blender source changed during export.');
if (exportReport.canonical_bones !== 49) failures.push('Canonical source is not the expected 49-bone rig.');
if (exportReport.action !== 'Idle' || exportReport.idle_frame !== 126) {
  failures.push('Runtime crowd asset was not baked from validated Idle frame 126.');
}
if (materialNames.some((name) => /wally|stripe/i.test(name))) {
  failures.push('Runtime crowd GLB contains a Wally-like material name.');
}

const trianglesByNode = {};
for (const [index, mesh] of (gltf.meshes ?? []).entries()) {
  const nodeName = nodeNames[index];
  let triangles = 0;
  for (const primitive of mesh.primitives ?? []) {
    const attributes = Object.keys(primitive.attributes ?? {}).sort();
    if (attributes.join(',') !== 'NORMAL,POSITION') {
      failures.push(`${nodeName} has unexpected attributes: ${attributes.join(', ')}.`);
    }
    if (!primitive.extensions?.KHR_draco_mesh_compression) {
      failures.push(`${nodeName} is missing Draco compression.`);
    }
    if (primitive.indices === undefined) {
      failures.push(`${nodeName} has no index accessor.`);
      continue;
    }
    triangles += (gltf.accessors?.[primitive.indices]?.count ?? 0) / 3;
  }
  trianglesByNode[nodeName] = triangles;
}

const triangleTotals = {
  high: sumTier(trianglesByNode, 'High'),
  medium: sumTier(trianglesByNode, 'Medium'),
  low: sumTier(trianglesByNode, 'Low'),
};
if (triangleTotals.high !== 5_622) failures.push(`High LOD changed: ${triangleTotals.high} triangles.`);
if (triangleTotals.medium > 920) failures.push(`Medium LOD exceeds 920 triangles: ${triangleTotals.medium}.`);
if (triangleTotals.low > 205) failures.push(`Low LOD exceeds 205 triangles: ${triangleTotals.low}.`);

const report = {
  generatedAt: new Date().toISOString(),
  pass: failures.length === 0,
  runtimePath,
  bytes: bytes.length,
  sha256,
  source: exportReport.source,
  sourceBlend: exportReport.source_blend,
  sourceBlendSha256: exportReport.source_blend_sha256_before,
  sourceBlendUnchanged: exportReport.source_blend_unchanged,
  action: exportReport.action,
  idleFrame: exportReport.idle_frame,
  nodes: nodeNames,
  meshes: meshNames,
  materials: materialNames,
  skins: gltf.skins?.length ?? 0,
  animations: gltf.animations?.length ?? 0,
  draco: (gltf.extensionsUsed ?? []).includes('KHR_draco_mesh_compression'),
  trianglesByNode,
  triangleTotals,
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

function sumTier(triangles, suffix) {
  return Object.entries(triangles)
    .filter(([name]) => name.endsWith(suffix))
    .reduce((sum, [, count]) => sum + count, 0);
}
