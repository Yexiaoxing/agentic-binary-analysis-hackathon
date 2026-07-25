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
2. Use the tool you like to deploy Gemma 4 12B on your local machine. You can use LM Studio, Ollama, etc.
3. Clone the repository
4. Run `pnpm install`
5. Create a `.env` file and set the `OPENAI_API_KEY` to the API key of your Gemma 4 instance.
6. Run `pnpm start`
7. Open the browser and go to `http://localhost:5173`

## How to use

1. Upload a binary file
2. Wait for the analysis to complete
3. View the report
