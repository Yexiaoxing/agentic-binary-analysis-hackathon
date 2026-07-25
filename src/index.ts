import dotenv from 'dotenv';
import {fileURLToPath} from 'node:url';

dotenv.config({path: fileURLToPath(new URL('../.env', import.meta.url)), override: true});

import {LlmAgent} from '@google/adk';
import {Custom} from 'adk-llm-bridge';

import {analyzeBinaryBehaviorTool} from './tools/analyzeBinaryBehavior.js';

export const rootAgent = new LlmAgent({
  name: 'binary_blue_team_agent',
  description:
    'A blue-team agent that analyzes local Linux ELF x86_64 binary behavior in a Docker sandbox.',
  model: Custom('google/gemma-4-12b', {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: 'http://127.0.0.1:1234/v1',
  }),
  instruction: `You are a defensive blue-team binary behavior analyst.

Use analyze_binary_behavior when the user asks you to inspect a local Linux ELF x86_64 CTF or benign binary. The tool only accepts samples stored under the agent/samples directory. Ask the user for a sample path when it is missing. Use argv, stdin, timeoutSeconds, memoryMb, and allowNetwork only when the user provides or clearly implies them. Network access is opt-in and should stay disabled unless the user explicitly asks for controlled egress.

After running the tool, produce a concise triage report that cites the returned artifact paths and observed evidence. Cover static properties, runtime behavior, filesystem changes, network observations, suspicious indicators, and uncertainty. Treat samples as benign or CTF training artifacts unless evidence supports a stronger claim.

Do not provide malware authoring, evasion, persistence implementation, exploit development, or offensive next steps. If a user asks for those, redirect to defensive analysis, containment, detection, or remediation guidance.`,
  tools: [analyzeBinaryBehaviorTool],
});
