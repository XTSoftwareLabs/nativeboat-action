import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const repository = 'XTSoftwareLabs/nativeboat-release';
const releasesUrl = `https://api.github.com/repos/${repository}/releases`;
const archivePattern = /^nativeboat-[0-9a-z][0-9a-z.-]*-windows-x64\.zip$/i;

function input(env, name, fallback = '') {
  return env[`INPUT_${name.toUpperCase()}`]?.trim() || fallback;
}

function booleanInput(env, name) {
  const value = input(env, name, 'false');
  if (!['true', 'false'].includes(value)) {
    throw new Error(`${name} must be true or false.`);
  }
  return value === 'true';
}

async function githubApi(url, token, fetchImpl) {
  return fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nativeboat-action',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
}

// `latest` prefers the newest stable release and falls back to the newest
// prerelease while the release repository only publishes previews.
export async function resolveRelease(version, token, fetchImpl = fetch) {
  const url = version === 'latest' ? `${releasesUrl}?per_page=50` : `${releasesUrl}/tags/${encodeURIComponent(version)}`;
  const response = await githubApi(url, token, fetchImpl);
  if (response.status === 404) {
    throw new Error(`NativeBoat release '${version}' is unavailable. Use an exact tag published in ${repository}.`);
  }
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed (HTTP ${response.status}). Check the token and GitHub API rate limit.`);
  }
  let release = await response.json();
  if (version === 'latest') {
    const published = Array.isArray(release) ? release.filter(item => !item.draft) : [];
    release = published.find(item => !item.prerelease) ?? published[0];
    if (!release) throw new Error(`${repository} has no published NativeBoat release.`);
  }
  if (release.draft || !release.tag_name || !Array.isArray(release.assets)) {
    throw new Error('NativeBoat release metadata must describe a published release with assets.');
  }
  return release;
}

export function selectArchive(release) {
  const archives = release.assets.filter(asset => archivePattern.test(asset.name));
  if (archives.length !== 1) {
    throw new Error(`Release '${release.tag_name}' needs exactly one nativeboat-<version>-windows-x64.zip asset.`);
  }
  return archives[0];
}

async function download(asset, destination, fetchImpl) {
  const url = new URL(asset.browser_download_url);
  const prefix = `/${repository}/releases/download/`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(prefix) || url.username || url.password) {
    throw new Error(`Unexpected download URL for ${asset.name}.`);
  }
  const response = await fetchImpl(url.href, {
    headers: { 'User-Agent': 'nativeboat-action' },
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download of ${asset.name} failed (HTTP ${response.status}).`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
  if (typeof asset.size === 'number' && (await stat(destination)).size !== asset.size) {
    throw new Error(`Downloaded size differs from release metadata for ${asset.name}.`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(destination)) hash.update(chunk);
  const actual = hash.digest('hex');
  if (asset.digest) {
    if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest) || asset.digest.slice(7).toLowerCase() !== actual) {
      throw new Error(`SHA-256 verification failed for ${asset.name}.`);
    }
  }
  return actual;
}

export async function execute(file, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} failed (${signal ? `signal ${signal}` : `exit code ${code}`}).`));
    });
  });
}

// The compiler sits at the package root (or inside one enclosing directory)
// with its bundled toolchain beside it.
async function findCompiler(directory) {
  const candidates = [directory];
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) candidates.push(path.join(directory, entries[0].name));
  for (const root of candidates) {
    const compiler = path.join(root, 'nativeboat.exe');
    if (!(await stat(compiler).catch(() => null))?.isFile()) continue;
    if (!(await stat(path.join(root, 'toolchain')).catch(() => null))?.isDirectory()) {
      throw new Error('The package must include the toolchain directory beside nativeboat.exe.');
    }
    return compiler;
  }
  throw new Error('The package must contain nativeboat.exe at its root.');
}

export async function installCompiler(release, tempDirectory, { fetchImpl = fetch, run = execute, env = process.env } = {}) {
  const archive = selectArchive(release);
  await mkdir(tempDirectory, { recursive: true });
  const directory = await mkdtemp(path.join(tempDirectory, 'nativeboat-'));
  const archivePath = path.join(directory, archive.name);
  const hash = await download(archive, archivePath, fetchImpl);

  const sums = release.assets.find(asset => asset.name === 'SHA256SUMS.txt');
  if (sums) {
    const sumsPath = path.join(directory, 'SHA256SUMS.txt');
    await download(sums, sumsPath, fetchImpl);
    const entries = new Map();
    for (const line of (await readFile(sumsPath, 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
      if (match) entries.set(match[2], match[1].toLowerCase());
    }
    if (entries.get(archive.name) !== hash) throw new Error(`SHA256SUMS.txt verification failed for ${archive.name}.`);
  }

  // Windows' bundled bsdtar extracts large ZIPs much faster than Expand-Archive.
  const extracted = path.join(directory, 'extracted');
  await mkdir(extracted);
  const tar = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  await run(tar, ['-xf', archivePath, '-C', extracted]);
  return findCompiler(extracted);
}

async function writeOutput(file, name, value) {
  const delimiter = `nativeboat_${randomUUID()}`;
  await appendFile(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, 'utf8');
}

async function findExecutable(output) {
  const entries = await readdir(output, { withFileTypes: true }).catch(() => []);
  const executables = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'));
  return executables.length === 1 ? path.join(output, executables[0].name) : '';
}

export async function runAction({ env = process.env, platform = process.platform, architecture = process.arch, fetchImpl = fetch, run = execute, log = console.log } = {}) {
  if (platform !== 'win32' || architecture !== 'x64') {
    throw new Error('NativeBoat requires a Windows x64 runner. Use runs-on: windows-latest.');
  }
  const analyze = booleanInput(env, 'analyze');
  const workspace = env.GITHUB_WORKSPACE;
  if (!workspace || !env.RUNNER_TEMP || !env.GITHUB_OUTPUT) {
    throw new Error('GITHUB_WORKSPACE, RUNNER_TEMP and GITHUB_OUTPUT are required.');
  }
  const project = path.resolve(workspace, input(env, 'project-path', '.'));
  if (!(await stat(project).catch(() => null))?.isDirectory()) {
    throw new Error(`Electron project directory is missing: ${project}`);
  }
  if (!(await stat(path.join(project, 'package.json')).catch(() => null))?.isFile()) {
    throw new Error(`Electron project needs package.json: ${project}`);
  }
  const output = path.resolve(project, input(env, 'output-path', 'native-dist'));
  const workDir = input(env, 'work-dir');
  const sign = input(env, 'sign');
  const release = await resolveRelease(input(env, 'version', 'latest'), input(env, 'token'), fetchImpl);
  log(`Installing NativeBoat ${release.tag_name}`);
  const compiler = await installCompiler(release, env.RUNNER_TEMP, { fetchImpl, run, env });
  // Keep workflow credentials out of compiler and project build processes.
  const buildEnv = { ...env };
  delete buildEnv.INPUT_TOKEN;
  await run(compiler, ['--version'], { cwd: project, env: buildEnv });
  if (analyze) await run(compiler, ['analyze', project], { cwd: project, env: buildEnv });
  const args = ['build', project, '--out', output];
  if (workDir) args.push('--work-dir', path.resolve(workspace, workDir));
  if (sign) args.push('--sign', sign);
  await run(compiler, args, { cwd: project, env: buildEnv });
  const executable = await findExecutable(output);
  await writeOutput(env.GITHUB_OUTPUT, 'output-path', output);
  await writeOutput(env.GITHUB_OUTPUT, 'executable', executable);
  await writeOutput(env.GITHUB_OUTPUT, 'compiler-path', compiler);
  await writeOutput(env.GITHUB_OUTPUT, 'version', release.tag_name);
  log(`NativeBoat build output: ${output}`);
}
