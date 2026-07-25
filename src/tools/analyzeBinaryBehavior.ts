import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import {analyzeBinaryBehavior} from '../sandbox/binarySandbox.js';

const analysisInputSchema = z.object({
  samplePath: z
    .string()
    .min(1)
    .describe('Relative path to a Linux ELF x86_64 sample under the agent/samples directory.'),
  argv: z
    .array(z.string())
    .default([])
    .describe('Optional command-line arguments for the sample.'),
  stdin: z
    .string()
    .default('')
    .describe('Optional standard input provided to the sample.'),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(120)
    .default(30)
    .describe('Runtime limit in seconds. Defaults to 30 and is capped at 120.'),
  memoryMb: z
    .number()
    .int()
    .min(64)
    .max(1024)
    .default(512)
    .describe('Container memory limit in MiB. Defaults to 512 and is capped at 1024.'),
  allowNetwork: z
    .boolean()
    .default(false)
    .describe('Opt-in outbound Docker networking. Defaults to false.'),
});

export const analyzeBinaryBehaviorTool = new FunctionTool({
  name: 'analyze_binary_behavior',
  description:
    'Analyze a local Linux ELF x86_64 CTF or benign binary inside a constrained Docker sandbox and return a full triage bundle with static, runtime, filesystem, and network evidence.',
  parameters: analysisInputSchema,
  execute: analyzeBinaryBehavior,
});
