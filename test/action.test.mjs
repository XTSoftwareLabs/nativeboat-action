import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execute, installCompiler, resolveRelease, runAction, selectArchive } from '../src/action.mjs';
import { parse } from 'yaml';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const archiveName = 'nativeboat-1.2.3-windows-x64.zip';

function asset(name, data, extra = {}) {
  return {
    name,
    browser_download_url: `https://github.com/XTSoftwareLabs/nativeboat-release/releases/download/v1.2.3/${name}`,
    size: Buffer.byteLength(data),
    digest: `sha256:${sha256(data)}`,
    ...extra,
  };
}

function packageFixture({ sums = false, archive = 'archive bytes' } = {}) {
  const files = new Map([[archiveName, archive]]);
  if (sums) files.set('SHA256SUMS.txt', `${sha256(archive)}  ${archiveName}`);
  return { files, release: { tag_name: 'v1.2.3', draft: false, assets: [...files].map(([name, data]) => asset(name, data)) } };
}

function fixtureFetch(fixture, requests = []) {
  return async (url, options) => {
    requests.push({ url, options });
    if (url.startsWith('https://api.github.com/')) {
      return Response.json(url.includes('/tags/') ? fixture.release : [fixture.release]);
    }
    const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    return fixture.files.has(name) ? new Response(fixture.files.get(name)) : new Response('', { status: 404 });
  };
}

// Simulates tar extraction of a release package into the `-C` directory.
function fakeExtract({ enclosing = '', toolchain = true, compiler = true } = {}) {
  return async (file, args) => {
    if (path.basename(file) !== 'tar.exe') return;
    const root = path.join(args[args.indexOf('-C') + 1], enclosing);
    await mkdir(root, { recursive: true });
    if (compiler) await writeFile(path.join(root, 'nativeboat.exe'), 'compiler');
    if (toolchain) await mkdir(path.join(root, 'toolchain', 'bin'), { recursive: true });
  };
}

async function temporary(t) {
  const base = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'nativeboat-action-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith('nativeboat-action-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return root;
}

async function actionFixture(t) {
  const root = await temporary(t);
  const project = path.join(root, 'electron app $; quote\'');
  await mkdir(project);
  await writeFile(path.join(project, 'package.json'), '{"name":"test-app","main":"main.js"}');
  return {
    project,
    env: {
      GITHUB_WORKSPACE: root,
      RUNNER_TEMP: path.join(root, 'runner temp'),
      GITHUB_OUTPUT: path.join(root, 'outputs'),
      'INPUT_PROJECT-PATH': path.basename(project),
      INPUT_TOKEN: 'test-token',
    },
  };
}

async function readOutputs(file) {
  const outputs = {};
  for (const match of (await readFile(file, 'utf8')).matchAll(/^([\w-]+)<<(\S+)\n([^]*?)\n?\2$/gm)) outputs[match[1]] = match[3];
  return outputs;
}

test('action metadata exposes documented inputs and a shipped entry point', async () => {
  const action = parse(await readFile(path.join(repoRoot, 'action.yml'), 'utf8'));
  assert.equal(action.runs.using, 'node24');
  assert.ok((await stat(path.join(repoRoot, action.runs.main))).isFile());
  assert.deepEqual(Object.keys(action.outputs), ['output-path', 'executable', 'compiler-path', 'version']);
  assert.deepEqual(Object.keys(action.inputs), ['project-path', 'version', 'output-path', 'work-dir', 'sign', 'analyze', 'token']);
  assert.equal(action.inputs['project-path'].default, '.');
  assert.equal(action.inputs['output-path'].default, 'native-dist');
  assert.equal(action.inputs.analyze.default, 'false');
  for (const name of ['ci', 'smoke']) {
    assert.ok(parse(await readFile(path.join(repoRoot, `.github/workflows/${name}.yml`), 'utf8')).jobs);
  }
  const fixture = JSON.parse(await readFile(path.join(repoRoot, 'test/fixtures/electron app/package.json'), 'utf8'));
  assert.ok(fixture.devDependencies.electron);
});

test('latest prefers the newest stable release and sends the token only to the API', async () => {
  const stable = { tag_name: 'v1.0.0', draft: false, prerelease: false, assets: [] };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return Response.json([
      { tag_name: 'v2.0.0', draft: true, prerelease: false, assets: [] },
      { tag_name: 'v1.1.0-alpha.1', draft: false, prerelease: true, assets: [] },
      stable,
    ]);
  };
  assert.deepEqual(await resolveRelease('latest', 'secret', fetchImpl), stable);
  assert.equal(requests[0].url, 'https://api.github.com/repos/XTSoftwareLabs/nativeboat-release/releases?per_page=50');
  assert.equal(requests[0].options.headers['User-Agent'], 'nativeboat-action');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret');
});

test('latest falls back to the newest prerelease when no stable release exists', async () => {
  const preview = { tag_name: 'v0.1.0-alpha.2', draft: false, prerelease: true, assets: [] };
  const release = await resolveRelease('latest', '', async () => Response.json([
    { tag_name: 'v0.2.0-alpha.1', draft: true, prerelease: true, assets: [] },
    preview,
    { tag_name: 'v0.1.0-alpha.1', draft: false, prerelease: true, assets: [] },
  ]));
  assert.deepEqual(release, preview);
  await assert.rejects(resolveRelease('latest', '', async () => Response.json([])), /no published NativeBoat release/);
});

test('release lookup preserves exact prerelease tags and supports an empty token', async () => {
  const fixture = packageFixture();
  const requests = [];
  await resolveRelease('0.1.0-alpha.1', '', fixtureFetch(fixture, requests));
  assert.equal(requests[0].url, 'https://api.github.com/repos/XTSoftwareLabs/nativeboat-release/releases/tags/0.1.0-alpha.1');
  assert.equal(requests[0].options.headers.Authorization, undefined);
});

test('release lookup reports missing releases, rate limits, and drafts', async () => {
  await assert.rejects(resolveRelease('v9', '', async () => new Response('', { status: 404 })), /exact tag/);
  await assert.rejects(resolveRelease('latest', '', async () => new Response('', { status: 403 })), /HTTP 403/);
  await assert.rejects(resolveRelease('v1', '', async () => Response.json({ draft: true })), /published release/);
});

test('archive selection requires exactly one Windows x64 ZIP', () => {
  const { release } = packageFixture({ sums: true });
  assert.equal(selectArchive(release).name, archiveName);
  assert.throws(() => selectArchive({ ...release, assets: [...release.assets, asset('nativeboat-1.2.4-windows-x64.zip', '')] }), /exactly one/);
  assert.throws(() => selectArchive({ ...release, assets: [asset('nativeboat-1.2.3-windows-arm64.zip', '')] }), /exactly one/);
  assert.throws(() => selectArchive({ ...release, assets: [asset('nativeboat.exe', '')] }), /exactly one/);
});

test('ZIP is checked against SHA256SUMS and extracted with Windows tar', async t => {
  const root = await temporary(t);
  const fixture = packageFixture({ sums: true });
  const requests = [];
  const commands = [];
  const extract = fakeExtract();
  const compiler = await installCompiler(fixture.release, root, {
    fetchImpl: fixtureFetch(fixture, requests),
    env: { SystemRoot: 'C:\\Windows' },
    run: async (file, args, options) => { commands.push({ file, args }); await extract(file, args, options); },
  });
  assert.equal(path.basename(compiler), 'nativeboat.exe');
  assert.equal(commands[0].file, path.join('C:\\Windows', 'System32', 'tar.exe'));
  assert.equal(commands[0].args[0], '-xf');
  assert.equal(path.basename(commands[0].args[1]), archiveName);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.options.headers.Authorization === undefined));
});

test('a single enclosing package directory is supported', async t => {
  const fixture = packageFixture();
  const compiler = await installCompiler(fixture.release, await temporary(t), {
    fetchImpl: fixtureFetch(fixture), run: fakeExtract({ enclosing: 'nativeboat-1.2.3-windows-x64' }),
  });
  assert.match(compiler, /nativeboat-1\.2\.3-windows-x64[\\/]nativeboat\.exe$/);
});

for (const kind of ['digest', 'size', 'sums', 'url', 'http']) {
  test(`installation rejects a ${kind} failure before extracting`, async t => {
    const root = await temporary(t);
    const fixture = packageFixture({ sums: kind === 'sums' });
    let pattern;
    if (kind === 'digest') {
      fixture.release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
      pattern = /SHA-256/;
    } else if (kind === 'size') {
      fixture.release.assets[0].size += 1;
      pattern = /size differs/;
    } else if (kind === 'sums') {
      fixture.files.set('SHA256SUMS.txt', `${'0'.repeat(64)}  ${archiveName}`);
      fixture.release.assets[1] = asset('SHA256SUMS.txt', fixture.files.get('SHA256SUMS.txt'));
      pattern = /SHA256SUMS.txt verification/;
    } else if (kind === 'url') {
      fixture.release.assets[0].browser_download_url = `https://example.com/${archiveName}`;
      pattern = /Unexpected download URL/;
    } else {
      pattern = /HTTP 503/;
    }
    await assert.rejects(installCompiler(fixture.release, root, {
      fetchImpl: kind === 'http' ? async () => new Response('', { status: 503 }) : fixtureFetch(fixture),
      run: () => assert.fail('Archive extracted after download failure'),
    }), pattern);
  });
}

test('older release assets without digest metadata are supported', async t => {
  const fixture = packageFixture();
  for (const item of fixture.release.assets) delete item.digest;
  const compiler = await installCompiler(fixture.release, await temporary(t), { fetchImpl: fixtureFetch(fixture), run: fakeExtract() });
  assert.ok((await stat(compiler)).isFile());
});

for (const [kind, options, pattern] of [
  ['missing-toolchain', { toolchain: false }, /toolchain directory/],
  ['missing-compiler', { compiler: false }, /nativeboat.exe at its root/],
  ['extraction-failure', null, /Archive is corrupt/],
]) {
  test(`installation rejects ${kind}`, async t => {
    const fixture = packageFixture();
    await assert.rejects(installCompiler(fixture.release, await temporary(t), {
      fetchImpl: fixtureFetch(fixture),
      run: options ? fakeExtract(options) : async () => { throw new Error('Archive is corrupt'); },
    }), pattern);
  });
}

test('build passes paths as arguments, removes the input token, and writes outputs', async t => {
  const { env, project } = await actionFixture(t);
  env['INPUT_OUTPUT-PATH'] = 'native output';
  env['INPUT_WORK-DIR'] = 'nb work';
  env.INPUT_SIGN = 'signtool sign /a {file}';
  env.INPUT_ANALYZE = 'true';
  const extract = fakeExtract();
  const commands = [];
  await runAction({
    env, platform: 'win32', architecture: 'x64', fetchImpl: fixtureFetch(packageFixture()), log: () => {},
    run: async (file, args, options) => {
      await extract(file, args);
      if (path.basename(file) !== 'nativeboat.exe') return;
      commands.push({ file, args, options });
      if (args[0] === 'build') {
        await mkdir(args[3], { recursive: true });
        await writeFile(path.join(args[3], 'Test App.exe'), 'app');
      }
    },
  });
  assert.deepEqual(commands.map(command => command.args[0]), ['--version', 'analyze', 'build']);
  assert.deepEqual(commands[1].args, ['analyze', project]);
  assert.deepEqual(commands[2].args, ['build', project, '--out', path.join(project, 'native output'),
    '--work-dir', path.join(env.GITHUB_WORKSPACE, 'nb work'), '--sign', 'signtool sign /a {file}']);
  assert.equal(commands[2].options.cwd, project);
  assert.equal(commands[2].options.env.INPUT_TOKEN, undefined);
  assert.equal(env.INPUT_TOKEN, 'test-token');
  assert.deepEqual(await readOutputs(env.GITHUB_OUTPUT), {
    'output-path': path.join(project, 'native output'),
    executable: path.join(project, 'native output', 'Test App.exe'),
    'compiler-path': commands[2].file,
    version: 'v1.2.3',
  });
});

test('default build uses workspace project, native-dist, and no optional flags', async t => {
  const { env, project } = await actionFixture(t);
  env.GITHUB_WORKSPACE = project;
  delete env['INPUT_PROJECT-PATH'];
  const extract = fakeExtract();
  const commands = [];
  await runAction({ env, platform: 'win32', architecture: 'x64', fetchImpl: fixtureFetch(packageFixture()), log: () => {},
    run: async (file, args) => { await extract(file, args); if (path.basename(file) === 'nativeboat.exe') commands.push(args); } });
  assert.deepEqual(commands, [['--version'], ['build', project, '--out', path.join(project, 'native-dist')]]);
  assert.equal((await readOutputs(env.GITHUB_OUTPUT)).executable, '');
});

test('absolute project and output paths are passed through', async t => {
  const { env, project } = await actionFixture(t);
  env['INPUT_PROJECT-PATH'] = project;
  env['INPUT_OUTPUT-PATH'] = path.join(env.GITHUB_WORKSPACE, 'artifacts');
  const extract = fakeExtract();
  const commands = [];
  await runAction({ env, platform: 'win32', architecture: 'x64', fetchImpl: fixtureFetch(packageFixture()), log: () => {},
    run: async (file, args) => { await extract(file, args); commands.push(args); } });
  assert.equal(commands.at(-1)[3], env['INPUT_OUTPUT-PATH']);
});

test('invalid runners and inputs fail before network access', async t => {
  const { env, project } = await actionFixture(t);
  const base = { env, platform: 'win32', architecture: 'x64', fetchImpl: () => assert.fail('Unexpected network request') };
  await assert.rejects(runAction({ ...base, platform: 'linux' }), /Windows x64/);
  await assert.rejects(runAction({ ...base, architecture: 'arm64' }), /Windows x64/);
  await assert.rejects(runAction({ ...base, env: {} }), /GITHUB_WORKSPACE/);
  await assert.rejects(runAction({ ...base, env: { ...env, INPUT_ANALYZE: 'yes' } }), /must be true or false/);
  await assert.rejects(runAction({ ...base, env: { ...env, 'INPUT_PROJECT-PATH': 'missing' } }), /directory is missing/);
  const empty = path.join(project, 'empty');
  await mkdir(empty);
  await assert.rejects(runAction({ ...base, env: { ...env, 'INPUT_PROJECT-PATH': empty } }), /needs package.json/);
});

for (const failingCommand of ['--version', 'build']) {
  test(`${failingCommand} failures propagate and leave success outputs unwritten`, async t => {
    const { env } = await actionFixture(t);
    const extract = fakeExtract();
    await assert.rejects(runAction({ env, platform: 'win32', architecture: 'x64', fetchImpl: fixtureFetch(packageFixture()), log: () => {},
      run: async (file, args) => {
        await extract(file, args);
        if (args[0] === failingCommand) throw new Error('Compiler failed (exit code 7)');
      } }), /exit code 7/);
    await assert.rejects(stat(env.GITHUB_OUTPUT), { code: 'ENOENT' });
  });
}

test('process execution propagates exit codes and launch errors', async () => {
  await execute(process.execPath, ['-e', 'process.exit(0)']);
  await assert.rejects(execute(process.execPath, ['-e', 'process.exit(7)']), /exit code 7/);
  await assert.rejects(execute('nativeboat-action-missing-command', []), /ENOENT/);
});

test('real tar ZIP extraction handles special characters in paths', { skip: process.platform !== 'win32' }, async t => {
  const root = await temporary(t);
  const source = path.join(root, "package space $;'");
  await mkdir(path.join(source, 'toolchain'), { recursive: true });
  await writeFile(path.join(source, 'nativeboat.exe'), 'compiler');
  await writeFile(path.join(source, 'toolchain', 'VERSION'), 'rustc');
  const zip = path.join(root, archiveName);
  await execute('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Compress-Archive -Path (Join-Path $env:TEST_SOURCE '*') -DestinationPath $env:TEST_ZIP"],
  { env: { ...process.env, TEST_SOURCE: source, TEST_ZIP: zip } });
  const bytes = await readFile(zip);
  const fixture = { files: new Map([[archiveName, bytes]]), release: { tag_name: 'v1.2.3', assets: [asset(archiveName, bytes)] } };
  const compiler = await installCompiler(fixture.release, path.join(root, "temp space $;'"), { fetchImpl: fixtureFetch(fixture) });
  assert.equal(await readFile(compiler, 'utf8'), 'compiler');
});
