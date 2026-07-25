import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants, existsSync} from 'node:fs';
import {access, copyFile, mkdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = resolveProjectRoot();
const samplesRoot = path.join(projectRoot, 'samples');
const runsRoot = path.join(projectRoot, 'runs');
const sandboxRoot = path.join(projectRoot, 'sandbox');
const dockerImageTag = 'gemma4-binary-sandbox:amd64-v3';
const dockerPlatform = 'linux/amd64';

const maxSampleBytes = 100 * 1024 * 1024;
const maxTimeoutSeconds = 120;
const maxMemoryMb = 1024;

export type BinaryAnalysisInput = {
  samplePath: string;
  argv?: string[];
  stdin?: string;
  timeoutSeconds?: number;
  memoryMb?: number;
  allowNetwork?: boolean;
};

export type BinaryAnalysisResult = {
  runId: string;
  status: 'completed' | 'error';
  summaryPath?: string;
  bundlePath?: string;
  artifactsDir?: string;
  staticFindings?: unknown;
  runtimeFindings?: unknown;
  networkFindings?: unknown;
  suspiciousIndicators?: unknown;
  errors: string[];
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

function resolveProjectRoot() {
  const candidates = [
    process.env.GEMMA4_AGENT_ROOT,
    process.env.INIT_CWD,
    process.cwd(),
    fileURLToPath(new URL('../..', import.meta.url)),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const root = findProjectRoot(candidate);
    if (root !== undefined) {
      return root;
    }
  }

  return process.cwd();
}

function findProjectRoot(startPath: string) {
  let current = path.resolve(startPath);

  while (true) {
    if (
      existsSync(path.join(current, 'package.json')) &&
      existsSync(path.join(current, 'sandbox', 'Dockerfile'))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: {cwd?: string} = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', exitCode => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function clampInteger(value: number | undefined, fallback: number, max: number) {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.trunc(value), max));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

async function pathExists(filePath: string) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveSamplePath(samplePath: string) {
  await mkdir(samplesRoot, {recursive: true});

  const normalizedSamplePath = samplePath.replaceAll('\\', '/');
  const projectRelativeSamplePath = normalizedSamplePath.startsWith('samples/')
    ? normalizedSamplePath
    : path.join('samples', normalizedSamplePath);

  const candidate = path.isAbsolute(samplePath)
    ? samplePath
    : path.join(projectRoot, projectRelativeSamplePath);

  const resolvedSamplesRoot = await realpath(samplesRoot);
  const resolvedCandidate = await realpath(candidate);
  const relative = path.relative(resolvedSamplesRoot, resolvedCandidate);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`samplePath must resolve under ${resolvedSamplesRoot}`);
  }

  return resolvedCandidate;
}

async function validateElfX86_64(filePath: string) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error('samplePath must point to a regular file');
  }

  if (fileStat.size > maxSampleBytes) {
    throw new Error(`sample exceeds ${maxSampleBytes} byte v1 limit`);
  }

  const header = await readFile(filePath, {encoding: null});
  if (header.length < 64) {
    throw new Error('sample is too small to be a Linux ELF x86_64 binary');
  }

  if (
    header[0] !== 0x7f ||
    header[1] !== 0x45 ||
    header[2] !== 0x4c ||
    header[3] !== 0x46
  ) {
    throw new Error('v1 supports only ELF binaries');
  }

  if (header[4] !== 2) {
    throw new Error('v1 supports only 64-bit ELF binaries');
  }

  if (header[5] !== 1) {
    throw new Error('v1 supports only little-endian ELF binaries');
  }

  const machine = header.readUInt16LE(18);
  if (machine !== 0x3e) {
    throw new Error('v1 supports only x86_64 ELF binaries');
  }
}

async function sha256File(filePath: string) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

async function ensureDockerImage() {
  const dockerAvailable = await runCommand('docker', ['--version']).catch(error => {
    throw new Error(
      `Docker is required but was not found or is not running: ${String(error)}`,
    );
  });

  if (dockerAvailable.exitCode !== 0) {
    throw new Error(`Docker is required: ${dockerAvailable.stderr.trim()}`);
  }

  const inspect = await runCommand('docker', ['image', 'inspect', dockerImageTag]);
  if (inspect.exitCode === 0) {
    return;
  }

  const build = await runCommand(
    'docker',
    ['build', '--platform', dockerPlatform, '-t', dockerImageTag, sandboxRoot],
    {cwd: projectRoot},
  );

  if (build.exitCode !== 0) {
    throw new Error(
      `failed to build sandbox image:\n${build.stdout}\n${build.stderr}`.trim(),
    );
  }
}

async function readReport(reportPath: string) {
  const rawReport = await readFile(reportPath, 'utf8');
  return JSON.parse(rawReport) as Record<string, unknown>;
}

export async function analyzeBinaryBehavior(
  input: BinaryAnalysisInput,
): Promise<BinaryAnalysisResult> {
  const errors: string[] = [];
  const argv = isStringArray(input.argv) ? input.argv : [];
  const stdin = typeof input.stdin === 'string' ? input.stdin : '';
  const timeoutSeconds = clampInteger(input.timeoutSeconds, 30, maxTimeoutSeconds);
  const memoryMb = clampInteger(input.memoryMb, 512, maxMemoryMb);
  const allowNetwork = input.allowNetwork === true;

  let runId = `failed-${Date.now()}`;

  try {
    const samplePath = await resolveSamplePath(input.samplePath);
    await validateElfX86_64(samplePath);

    const hash = await sha256File(samplePath);
    runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${hash.slice(0, 12)}`;
    const runDir = path.join(runsRoot, runId);
    const artifactsDir = path.join(runDir, 'artifacts');

    await mkdir(runDir, {recursive: true});
    await copyFile(samplePath, path.join(runDir, 'sample'));
    await writeFile(path.join(runDir, 'stdin.txt'), stdin);

    await ensureDockerImage();

    let networkName: string | undefined;
    if (allowNetwork) {
      networkName = `gemma4-sandbox-${hash.slice(0, 12)}-${Date.now()}`;
      const network = await runCommand('docker', ['network', 'create', networkName]);
      if (network.exitCode !== 0) {
        throw new Error(
          `failed to create Docker analysis network:\n${network.stdout}\n${network.stderr}`.trim(),
        );
      }
    }

    const dockerArgs = [
      'run',
      '--rm',
      '--platform',
      dockerPlatform,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--pids-limit',
      '128',
      '--memory',
      `${memoryMb}m`,
      '--cpus',
      '1',
      '--security-opt',
      'no-new-privileges',
      '--security-opt',
      'seccomp=unconfined',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'SYS_PTRACE',
      '--env',
      `RUN_ID=${runId}`,
      '--env',
      `TIMEOUT_SECONDS=${timeoutSeconds}`,
      '--env',
      `ALLOW_NETWORK=${allowNetwork ? 'true' : 'false'}`,
      '--env',
      'STDIN_FILE=/analysis/stdin.txt',
      '--mount',
      `type=bind,source=${runDir},target=/analysis`,
    ];

    if (allowNetwork && networkName !== undefined) {
      dockerArgs.push(
        '--network',
        networkName,
        '--cap-add',
        'NET_RAW',
        '--cap-add',
        'NET_ADMIN',
      );
    } else {
      dockerArgs.push('--network', 'none');
    }

    dockerArgs.push(dockerImageTag, '/analysis/sample', ...argv);

    let run: CommandResult;
    try {
      run = await runCommand('docker', dockerArgs, {cwd: projectRoot});
    } finally {
      if (networkName !== undefined) {
        await runCommand('docker', ['network', 'rm', networkName]);
      }
    }
    await writeFile(path.join(runDir, 'docker.stdout.txt'), run.stdout);
    await writeFile(path.join(runDir, 'docker.stderr.txt'), run.stderr);

    const reportPath = path.join(runDir, 'report.json');
    if (!(await pathExists(reportPath))) {
      throw new Error(
        `sandbox did not produce report.json; docker exit code ${run.exitCode}`,
      );
    }

    const report = await readReport(reportPath);
    if (run.exitCode !== 0) {
      errors.push(`docker exited with code ${run.exitCode}`);
    }

    return {
      runId,
      status: 'completed',
      summaryPath: path.join(runDir, 'report.md'),
      bundlePath: runDir,
      artifactsDir,
      staticFindings: report.staticFindings,
      runtimeFindings: report.runtimeFindings,
      networkFindings: report.networkFindings,
      suspiciousIndicators: report.suspiciousIndicators,
      errors,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return {
      runId,
      status: 'error',
      errors,
    };
  }
}
