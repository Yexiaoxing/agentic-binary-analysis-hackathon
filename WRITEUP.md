# Proof of Work: Gemma 4 Blue-Team Binary Analysis Agent

## Summary

This project is a working agentic security demo built to let blue team testers analyze binaries. It uses Gemma 4 through Google ADK to analyze Linux ELF x86_64 binaries in a Docker sandbox and produce a defensive triage report.

A user can upload a sample in the React UI, the API runs the ADK agent, Gemma 4 calls a real analysis tool, Docker collects evidence, and the UI renders Gemma 4's final report as Markdown.

## Architecture

The project is a node project with the following structure:

```text
src/index.ts                       ADK root agent using Gemma 4
src/tools/analyzeBinaryBehavior.ts ADK FunctionTool definition
src/sandbox/binarySandbox.ts       Host-side Docker runner
sandbox/Dockerfile                 Analysis image
sandbox/analyze.sh                 Container-side analyzer
web/server/index.ts                Express API using ADK Runner
web/src/main.tsx                   React upload/results UI
samples/                           Local sample staging
runs/                              Generated analysis bundles
```

Main flow:

```text
React upload
  -> Express API
  -> ADK Runner
  -> Gemma 4 rootAgent
  -> analyze_binary_behavior tool
  -> Docker sandbox
  -> report.json/report.md
  -> Gemma 4 final triage
  -> React results UI
```

## How Gemma 4 Is Used

Gemma 4 is configured in `src/index.ts` through `adk-llm-bridge` with a local OpenAI-compatible endpoint (deployed using LM Studio):

```ts
model: Custom("google/gemma-4-12b", {
    apiKey: process.env.OPENAI_API_KEY || "",
    baseURL: "http://127.0.0.1:1234/v1",
});
```

Gemma 4 is used as the analyst and tool-calling agent. It does not directly run shell commands. Instead, ADK gives it a typed tool:

```ts
{
  samplePath: string;
  argv?: string[];
  stdin?: string;
  timeoutSeconds?: number;
  memoryMb?: number;
  allowNetwork?: boolean;
}
```

Gemma 4 decides to call `analyze_binary_behavior`, receives the tool result, and then analyze the evidence and write a concise blue-team report grounded in the generated artifacts.

## Sandbox Evidence

The Docker sandbox is built as `linux/amd64` so it can run x86_64 ELF samples.

The runner validates the sample before execution:

- file must be a regular ELF x86_64 binary
- max sample size is 100 MiB
- default timeout is 30 seconds
- default memory limit is 512 MiB
- network is disabled unless explicitly enabled

Docker runs with a read-only root filesystem, limited memory/CPU/PIDs, dropped capabilities, and `--network none` by default. `SYS_PTRACE` is added so `strace` and `ltrace` can collect behavior. Optional network runs create a temporary Docker bridge network and capture packets with `tcpdump`.

Each run produces an artifact bundle under `runs/<runId>/`:

```text
report.json
report.md
artifacts/static/      hashes, file type, ELF metadata, strings, symbols
artifacts/runtime/     stdout, stderr, strace, ltrace, process snapshots
artifacts/filesystem/  before/after snapshots and diffs
artifacts/network/     optional packet capture
```

This makes the LLM output auditable. Judges can inspect the raw evidence behind the final report.

## Web Demo

The React UI lets a user:

- upload a sample
- set argv/stdin/time/memory/network options
- start analysis
- view raw findings
- view ADK event metadata
- read Gemma 4's Markdown triage report

The web API intentionally uses ADK instead of calling the sandbox runner
directly. This proves the real agent path:

```text
web API -> ADK Runner -> rootAgent -> FunctionTool -> Docker sandbox
```

## Why These Choices

- Google ADK is the right fit because this is a tool-calling agent, not just a chat prompt. We can further integrate more tools in the future so to make this more useful.
- Gemma 4 is used for reasoning and reporting, while deterministic tools gather evidence. Provided the on-device deployment of Gemma 4, we can use it to analyze the binaries without the need to use cloud instances of LLMs. A perfect fit for security use cases.
- Docker is pragmatic for a simple sandbox and easy for judges to run locally. Further on we will need a more complex sandbox to analyze the binaries more thoroughly.
- Artifact bundles make the model's conclusions verifiable.
- A React UI makes the demo accessible without hiding the technical details.

## Verification

The system was tested with an uploaded `curl` ELF sample and argv
`["--version"]`.

The verified path was:

```text
React upload -> Express API -> ADK Runner -> Gemma 4 -> Docker analysis -> React report
```

The run completed, produced an artifact bundle, returned `report.md`, emitted an ADK function response for `analyze_binary_behavior`, and rendered Gemma 4's final report in the UI.

## How To Run

From `agent/`:

```bash
pnpm install
pnpm build
pnpm webapp:dev
```

Then open:

```text
http://127.0.0.1:5173/
```

Docker and the local Gemma 4 OpenAI-compatible endpoint at
`http://127.0.0.1:1234/v1` must be running.
