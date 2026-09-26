import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = join(scriptDirectory, '..');
const packageRoot = join(projectRoot, 'node_modules', 'pdfjs-dist');
const publicRoot = join(projectRoot, 'public');
const resourceDirectories = ['cmaps', 'iccs', 'standard_fonts', 'wasm'];
const resourceVersionFile = join(projectRoot, 'src', 'utils', 'pdfjsResourceVersion.ts');

const listFiles = (directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  })
  .sort();

const sha256 = (contents) => createHash('sha256').update(contents).digest('hex');

export const getPdfJsResourceVersion = (sourceRoot = packageRoot) => {
  const packageVersion = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')).version;
  const hash = createHash('sha256');
  for (const directory of resourceDirectories) {
    for (const file of listFiles(join(sourceRoot, directory))) {
      hash.update(relative(sourceRoot, file).replaceAll('\\', '/'));
      hash.update(readFileSync(file));
    }
  }
  // The worker contains the WebAssembly glue. Include the exact bundled source
  // so a worker-only PDF.js update cannot reuse an older resource URL.
  hash.update('build/pdf.worker.min.mjs');
  hash.update(readFileSync(join(sourceRoot, 'build', 'pdf.worker.min.mjs')));
  return `${packageVersion}-${hash.digest('hex').slice(0, 16)}`;
};

const resourceManifest = (sourceRoot) => Object.fromEntries(
  resourceDirectories.flatMap((directory) => listFiles(join(sourceRoot, directory)).map((file) => [
    relative(sourceRoot, file).replaceAll('\\', '/'),
    sha256(readFileSync(file)),
  ])),
);

const assertWasmGlueMatches = (sourceRoot) => {
  const workerSource = readFileSync(join(sourceRoot, 'build', 'pdf.worker.min.mjs'), 'utf8');
  for (const file of listFiles(join(sourceRoot, 'wasm')).filter((path) => path.endsWith('.wasm'))) {
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(file)));
    for (const wasmImport of imports) {
      if (wasmImport.module === './qcms_bg.js' && !workerSource.includes(wasmImport.name)) {
        throw new Error(`${basename(file)} imports ${wasmImport.name}, which is absent from the PDF.js worker glue.`);
      }
    }
  }
};

export const verifyPdfJsWasmInstantiation = async (sourceRoot = packageRoot) => {
  for (const file of listFiles(join(sourceRoot, 'wasm')).filter((path) => path.endsWith('.wasm'))) {
    const module = new WebAssembly.Module(readFileSync(file));
    const imports = {};
    for (const wasmImport of WebAssembly.Module.imports(module)) {
      imports[wasmImport.module] ??= {};
      // This checks binary loading with callable imports, not real glue behavior.
      // Resource hashes/glue-name checks and real browser rendering complement it.
      imports[wasmImport.module][wasmImport.name] = () => 0;
    }
    await WebAssembly.instantiate(module, imports);
  }
};

export const verifyPdfJsResources = ({ sourceRoot = packageRoot, targetRoot = publicRoot } = {}) => {
  const version = getPdfJsResourceVersion(sourceRoot);
  const targetDirectory = join(targetRoot, 'pdfjs', version);
  if (!existsSync(targetDirectory)) throw new Error(`PDF.js resources are missing: ${targetDirectory}`);

  const expectedManifest = resourceManifest(sourceRoot);
  const actualManifest = resourceManifest(targetDirectory);
  if (JSON.stringify(actualManifest) !== JSON.stringify(expectedManifest)) {
    throw new Error('PDF.js resources differ from the installed pdfjs-dist package. Run npm run pdfjs:sync.');
  }
  if (targetRoot === publicRoot) {
    const expectedVersionSource = `export const PDFJS_RESOURCE_VERSION = '${version}';`;
    if (!readFileSync(resourceVersionFile, 'utf8').includes(expectedVersionSource)) {
      throw new Error('The PDF.js resource URL version is stale. Run npm run pdfjs:sync.');
    }
  }
  assertWasmGlueMatches(sourceRoot);
  return { version, targetDirectory };
};

const isSafeTemporaryDirectory = (directory) => {
  const temporaryDirectory = resolve(tmpdir());
  const resolvedDirectory = resolve(directory);
  return resolvedDirectory.startsWith(`${temporaryDirectory}\\pdfjs-resources-`) ||
    resolvedDirectory.startsWith(`${temporaryDirectory}/pdfjs-resources-`);
};

export const syncPdfJsResources = ({ sourceRoot = packageRoot, targetRoot = publicRoot } = {}) => {
  try {
    return verifyPdfJsResources({ sourceRoot, targetRoot });
  } catch {
    // Copy only when the deterministic verification found missing or drifted files.
  }
  const version = getPdfJsResourceVersion(sourceRoot);
  const targetDirectory = join(targetRoot, 'pdfjs', version);
  mkdirSync(targetDirectory, { recursive: true });
  for (const directory of resourceDirectories) {
    cpSync(join(sourceRoot, directory), join(targetDirectory, directory), { recursive: true, force: true });
  }
  writeFileSync(join(targetDirectory, 'resource-manifest.json'), `${JSON.stringify({ version, files: resourceManifest(sourceRoot) }, null, 2)}\n`);
  if (targetRoot === publicRoot) {
    const versionSource = `// Generated by scripts/pdfjs-resources.mjs.\nexport const PDFJS_RESOURCE_VERSION = '${version}';\n`;
    if (!existsSync(resourceVersionFile) || readFileSync(resourceVersionFile, 'utf8') !== versionSource) {
      writeFileSync(resourceVersionFile, versionSource);
    }
  }
  return verifyPdfJsResources({ sourceRoot, targetRoot });
};

const isDirectExecution = basename(process.argv[1] ?? '') === 'pdfjs-resources.mjs';
const command = process.argv[2];
if (isDirectExecution && command === 'sync') {
  const result = syncPdfJsResources();
  process.stdout.write(`PDF.js resources synchronized at ${result.targetDirectory}\n`);
} else if (isDirectExecution && command === 'check') {
  const result = verifyPdfJsResources();
  process.stdout.write(`PDF.js resources verified at ${result.targetDirectory}\n`);
} else if (isDirectExecution && command === 'check-dist') {
  const result = verifyPdfJsResources({ targetRoot: join(projectRoot, 'dist') });
  process.stdout.write(`Built PDF.js resources verified at ${result.targetDirectory}\n`);
} else if (isDirectExecution && command === 'self-test') {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'pdfjs-resources-'));
  try {
    syncPdfJsResources({ targetRoot: temporaryRoot });
    await verifyPdfJsWasmInstantiation();
    const version = getPdfJsResourceVersion();
    const driftedFile = join(temporaryRoot, 'pdfjs', version, 'cmaps', 'LICENSE');
    writeFileSync(driftedFile, 'intentional drift');
    let detected = false;
    try {
      verifyPdfJsResources({ targetRoot: temporaryRoot });
    } catch (error) {
      detected = error instanceof Error && error.message.includes('differ');
    }
    if (!detected) throw new Error('Intentional PDF.js resource drift was not detected.');
    process.stdout.write('PDF.js resource drift detection passed.\n');
  } finally {
    if (!isSafeTemporaryDirectory(temporaryRoot)) {
      throw new Error(`Refusing to remove an unsafe temporary directory: ${temporaryRoot}`);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
} else if (isDirectExecution && command) {
  throw new Error('Usage: node scripts/pdfjs-resources.mjs <sync|check|check-dist|self-test>');
}
