import { build } from 'esbuild';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--out-dir', '--metafile'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw Error('Use build-frontend.mjs [--out-dir directory] [--metafile file]');
  options.set(key, resolve(root, value));
}
const outputRoot = options.get('--out-dir') ?? root;
const lock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
const release = JSON.parse(await readFile(join(root, 'vendor/xsec-ui/release.json'), 'utf8'));
for (const item of release.packages) {
  const actual = createHash('sha256').update(await readFile(join(root, 'vendor/xsec-ui', item.file))).digest('hex');
  if (actual !== item.sha256) throw Error('Shared UI package checksum differs: ' + item.file);
}
const result = await build({
  absWorkingDir: root, entryPoints: ['com.xsec.desktop/frontend-src/index.tsx'], outfile: 'com.xsec.desktop/frontend/index.js',
  bundle: true, format: 'esm', target: ['safari16', 'chrome105', 'es2022'], jsx: 'automatic',
  loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  minify: true, legalComments: 'none', metafile: true, write: false,
  banner: { js: '/*! Third-party licenses: ../THIRD_PARTY_NOTICES.txt */' },
});
for (const output of Object.values(result.metafile.outputs)) {
  if (output.imports.some(entry => entry.external)) throw Error('Plugin frontend has an external module import');
}
if (result.outputFiles.length !== 1) throw Error('Plugin frontend must emit a single module');
const output = result.outputFiles[0].text, exported = output.match(/export\{([A-Za-z_$][\w$]*) as createController\};\s*$/);
if (!exported || exported[1] === 'createController') throw Error('Generated controller export is invalid');
const activation = await readFile(join(root, 'scripts/activate-source.js'), 'utf8');
if ((activation.match(/__CONTROLLER__/g) ?? []).length !== 1) throw Error('Activator controller placeholder is invalid');
const source = output.slice(0, exported.index) + activation.replace('__CONTROLLER__', exported[1]);
const dependencies = new Map();
const emittedInputs = new Set(Object.values(result.metafile.outputs).flatMap(output =>
  Object.entries(output.inputs).filter(([, contribution]) => contribution.bytesInOutput > 0).map(([input]) => input)));
for (const input of emittedInputs) {
  if (!input.includes('node_modules/')) continue;
  let directory = dirname(resolve(root, input));
  while (true) {
    const path = join(directory, 'package.json');
    if (existsSync(path)) {
      const metadata = JSON.parse(await readFile(path, 'utf8'));
      if (metadata.name && metadata.version) { dependencies.set(metadata.name + '@' + metadata.version, directory); break; }
    }
    const parent = dirname(directory);
    if (parent === directory) throw Error('Bundled dependency metadata is missing');
    directory = parent;
  }
}
const notices = ['Third-party licenses for the system terminal frontend\n'], components = [];
for (const [name, directory] of [...dependencies].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const lockedId = metadata.name.startsWith('@xsec/')
    ? metadata.name + '@file:vendor/xsec-ui/' + metadata.name.replace('@xsec/', 'xsec-') + '-' + metadata.version + '.tgz'
    : name;
  if (!lock.includes(lockedId + ':') && !lock.includes(lockedId + "':") && !lock.includes(lockedId + '(')) throw Error('Bundled dependency differs from lockfile: ' + name);
  if (typeof metadata.license !== 'string' || !metadata.license) throw Error('Bundled dependency license metadata is missing: ' + name);
  components.push({ type: 'library', 'bom-ref': 'frontend:' + name, name: metadata.name, version: metadata.version,
    licenses: [{ expression: metadata.license }], purl: 'pkg:npm/' + metadata.name.replace('@', '%40') + '@' + metadata.version });
  const files = (await readdir(directory)).filter(file => /^licen[cs]e(?:[._-].*)?$/i.test(file)).sort();
  if (!files.length) throw Error('Bundled dependency license is missing: ' + name);
  notices.push('\n## ' + name + '\n');
  for (const file of files) notices.push(await readFile(join(directory, file), 'utf8'));
  const attribution = join(directory, 'THIRD_PARTY_NOTICES.md');
  if (existsSync(attribution)) notices.push(await readFile(attribution, 'utf8'));
}
await mkdir(join(outputRoot, 'com.xsec.desktop/frontend'), { recursive: true });
await writeFile(join(outputRoot, 'com.xsec.desktop/frontend/index.js'), source);
await writeFile(join(outputRoot, 'com.xsec.desktop/THIRD_PARTY_NOTICES.txt'), notices.join('\n').trimEnd() + '\n');
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8')), frontendRef = manifest.name + '/frontend';
const sbom = { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
  metadata: { component: { type: 'application', 'bom-ref': frontendRef, name: manifest.name + ' frontend', version: manifest.version,
    licenses: [{ expression: manifest.license }], hashes: [{ alg: 'SHA-256', content: createHash('sha256').update(source).digest('hex') }] } },
  components, dependencies: [{ ref: frontendRef, dependsOn: components.map(component => component['bom-ref']) }] };
await writeFile(join(outputRoot, 'com.xsec.desktop/frontend-sbom.cdx.json'), JSON.stringify(sbom, null, 2) + '\n');
if (options.has('--metafile')) await writeFile(options.get('--metafile'), JSON.stringify(result.metafile, null, 2) + '\n', { flag: 'wx' });
