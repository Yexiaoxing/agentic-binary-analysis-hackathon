import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import express from 'express';
import multer from 'multer';

import * as adk from '@google/adk';
import {FunctionResponse} from "@google/genai";
import type * as AdkModule from "@google/adk";
import * as agentModule from '../../src/index.js';
import { AssetKey } from 'node:sea';

type AnalyzerInput = {
  samplePath: string;
  argv?: string[];
  stdin?: string;
  timeoutSeconds?: number;
  memoryMb?: number;
  allowNetwork?: boolean;
};

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const agentRoot = path.resolve(webRoot, '..');
const uploadsRoot = path.join(agentRoot, 'samples', 'uploads');
const adkUrl = pathToFileURL(
  path.join(agentRoot, 'node_modules', '@google', 'adk', 'dist', 'esm', 'index.js'),
).href;
const agentUrl = pathToFileURL(path.join(agentRoot, 'dist', 'index.js')).href;

process.env.GEMMA4_AGENT_ROOT = agentRoot;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1,
  },
});

async function loadAdkRuntime() {
    const runner = new adk.Runner({
      appName: 'gemma4_binary_analysis_web',
      agent: agentModule.rootAgent,
      sessionService: new adk.InMemorySessionService(),
    });

    return {adk, runner};
}

function parseBoolean(value: unknown) {
  return value === 'true' || value === true;
}

function parseOptionalInteger(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function parseArgv(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Fall back to whitespace splitting for quick manual use.
  }

  return value.split(/\s+/).filter(Boolean);
}

function safeFileName(name: string) {
  return path.basename(name).replaceAll(/[^a-zA-Z0-9._-]/g, '_') || 'sample.bin';
}

async function readTextIfPresent(filePath: string | undefined) {
  if (filePath === undefined) {
    return undefined;
  }

  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function buildAdkPrompt(input: AnalyzerInput) {
  return `Analyze the uploaded binary sample by calling analyze_binary_behavior exactly once with these arguments:

samplePath: ${JSON.stringify(input.samplePath)}
argv: ${JSON.stringify(input.argv ?? [])}
stdin: ${JSON.stringify(input.stdin ?? '')}
timeoutSeconds: ${input.timeoutSeconds ?? 30}
memoryMb: ${input.memoryMb ?? 512}
allowNetwork: ${input.allowNetwork === true ? 'true' : 'false'}

After the tool returns, write a concise blue-team triage summary grounded in the returned artifact paths and evidence.`;
}

function compactEvent(event: adk.Event) {
  const asRecord = event as unknown as Record<string, unknown>;
  let text = '';
  let functionResponses: FunctionResponse[] = [];

  try {
    text = adk.stringifyContent(event);
  } catch {
    text = '';
  }

  try {
    functionResponses = adk.getFunctionResponses(event);
  } catch {
    functionResponses = [];
  }

  return {
    id: asRecord.id,
    author: asRecord.author,
    final: adk.isFinalResponse(event),
    text,
    functionResponses: functionResponses.map(response => ({
      name: response.name,
      hasResponse: response.response !== undefined,
    })),
  };
}

async function runAnalysisThroughAdk(input: AnalyzerInput) {
  const {adk, runner} = await loadAdkRuntime();
  const events: ReturnType<typeof compactEvent>[] = [];
  let agentText = '';
  let toolResult: unknown;

  for await (const event of runner.runEphemeral({
    userId: 'web-user',
    newMessage: {parts: [{text: buildAdkPrompt(input)}]},
  })) {
    events.push(compactEvent(event));

    const functionResponses = adk.getFunctionResponses(event);
    for (const functionResponse of functionResponses) {
      if (functionResponse.name === 'analyze_binary_behavior') {
        toolResult = functionResponse.response ?? functionResponse;
      }
    }

    if (adk.isFinalResponse(event)) {
      agentText = adk.stringifyContent(event);
    }
  }

  return {agentText, events, toolResult};
}

app.get('/api/health', (_request, response) => {
  response.json({ok: true});
});

app.post('/api/analyze', upload.single('sample'), async (request, response) => {
  try {
    if (request.file === undefined) {
      response.status(400).json({error: 'Missing sample upload'});
      return;
    }

    await mkdir(uploadsRoot, {recursive: true});

    const hash = createHash('sha256').update(request.file.buffer).digest('hex');
    const filename = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${hash.slice(0, 12)}-${safeFileName(request.file.originalname)}`;
    const samplePath = path.join(uploadsRoot, filename);
    await writeFile(samplePath, request.file.buffer, {mode: 0o600});

    const relativeSamplePath = path.posix.join('samples', 'uploads', filename);
    const analysisInput = {
      samplePath: relativeSamplePath,
      argv: parseArgv(request.body.argv),
      stdin: typeof request.body.stdin === 'string' ? request.body.stdin : '',
      timeoutSeconds: parseOptionalInteger(request.body.timeoutSeconds),
      memoryMb: parseOptionalInteger(request.body.memoryMb),
      allowNetwork: parseBoolean(request.body.allowNetwork),
    } satisfies AnalyzerInput;

    const adkResult = await runAnalysisThroughAdk(analysisInput);
    const result = (adkResult.toolResult ?? {
      status: 'error',
      errors: ['ADK agent did not return an analyze_binary_behavior tool response'],
    }) as Record<string, unknown>;

    const reportMarkdown = await readTextIfPresent(
      typeof result.summaryPath === 'string' ? result.summaryPath : undefined,
    );

    response.json({
      upload: {
        originalName: request.file.originalname,
        samplePath: relativeSamplePath,
        sha256: hash,
        size: request.file.size,
      },
      result,
      agentText: adkResult.agentText,
      adkEvents: adkResult.events,
      reportMarkdown,
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

const port = Number(process.env.PORT || 8787);
app.listen(port, '127.0.0.1', () => {
  console.log(`Binary analysis API listening on http://127.0.0.1:${port}`);
});
