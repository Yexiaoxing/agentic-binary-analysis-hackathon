# Binary Analysis Agent

> [!CAUTION]
> This project is a work that produced during the [hackathon](https://www.kaggle.com/competitions/gemma-4-lab-ai-driven-defense-offline-privacy). It is not a production-ready solution and is not intended to be used in a production environment.

## Overview

This project is a tool that allows you to analyze binaries using Gemma 4 and Docker.

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

## How to run

1. Install Docker
2. Clone the repository
3. Run `pnpm install`
4. Run `pnpm start`
5. Open the browser and go to `http://localhost:5173`

## How to use

1. Upload a binary file
2. Wait for the analysis to complete
3. View the report
