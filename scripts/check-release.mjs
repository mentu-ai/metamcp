#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fail(problems) {
  console.error(`Release contract failed — ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const server = readJson('server.json');
const readme = readFileSync('README.md', 'utf8');
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const releaseNotes = readFileSync('RELEASE_NOTES.md', 'utf8');
const problems = [];

const versions = [
  ['package-lock.json top level', lock.version],
  ['package-lock.json root package', lock.packages?.['']?.version],
  ['server.json', server.version],
  ['server.json npm package', server.packages?.find(entry => entry.registryType === 'npm')?.version],
];
for (const [surface, version] of versions) {
  if (version !== pkg.version) problems.push(`${surface} is ${version ?? 'missing'}, expected ${pkg.version}`);
}

if (pkg.mcpName !== server.name) {
  problems.push(`package.json mcpName is ${pkg.mcpName ?? 'missing'}, expected ${server.name ?? 'missing'}`);
}
if (server.description?.length > 100) {
  problems.push(`server.json description is ${server.description.length} characters; the MCP Registry maximum is 100`);
}
if (!pkg.files?.includes('server.json')) {
  problems.push('package.json files does not ship server.json');
}
if (pkg.publishConfig?.access !== 'public' || pkg.publishConfig?.registry !== 'https://registry.npmjs.org/') {
  problems.push('package.json publishConfig must pin public access on the official npm registry');
}
const npmPackage = server.packages?.find(entry => entry.registryType === 'npm');
if (npmPackage?.identifier !== pkg.name) {
  problems.push(`server.json npm identifier is ${npmPackage?.identifier ?? 'missing'}, expected ${pkg.name}`);
}

const surface = spawnSync(process.execPath, ['dist/index.js', 'tools', '--json'], {
  encoding: 'utf8',
  timeout: 10_000,
});
if (surface.status !== 0) {
  problems.push(`metamcp tools --json exited ${surface.status ?? 'without a status'}: ${surface.stderr.trim() || 'no stderr'}`);
} else {
  try {
    const result = JSON.parse(surface.stdout);
    const names = result.tools?.map(tool => tool.name) ?? [];
    const expected = ['mcp_discover', 'mcp_call', 'mcp_run'];
    if (result.version !== pkg.version) problems.push(`tools --json reports version ${result.version}, expected ${pkg.version}`);
    if (result.toolCount !== expected.length || JSON.stringify(names) !== JSON.stringify(expected)) {
      problems.push(`tools --json reports [${names.join(', ')}], expected [${expected.join(', ')}]`);
    }
    for (const name of expected) {
      if (!readme.includes(`\`${name}\``)) problems.push(`README does not name ${name}`);
    }
  } catch (error) {
    problems.push(`metamcp tools --json did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (!readme.includes('npx @mentu/metamcp@latest tools --json')) {
  problems.push('README does not document the machine-readable surface inspector');
}
if (!changelog.includes(`## v${pkg.version}\n\nReleased `)) {
  problems.push(`CHANGELOG.md does not mark v${pkg.version} as released`);
}
if (!releaseNotes.startsWith(`# MetaMCP v${pkg.version}\n`)) {
  problems.push(`RELEASE_NOTES.md is not prepared for v${pkg.version}`);
}

if (problems.length > 0) fail(problems);

console.log(`release contract OK — ${pkg.name}@${pkg.version}, ${server.name}, 3 tools`);
