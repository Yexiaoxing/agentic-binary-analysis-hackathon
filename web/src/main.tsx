import React, {useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Activity, FileUp, Loader2, Network, Play, ShieldCheck, Terminal} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import './styles.css';

type AnalyzeResponse = {
  upload: {
    originalName: string;
    samplePath: string;
    sha256: string;
    size: number;
  };
  result: {
    runId?: string;
    status?: string;
    summaryPath?: string;
    bundlePath?: string;
    artifactsDir?: string;
    staticFindings?: unknown;
    runtimeFindings?: unknown;
    networkFindings?: unknown;
    suspiciousIndicators?: unknown;
    errors?: string[];
  };
  agentText?: string;
  adkEvents?: unknown[];
  reportMarkdown?: string;
};

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [argv, setArgv] = useState('[]');
  const [stdin, setStdin] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [memoryMb, setMemoryMb] = useState(512);
  const [allowNetwork, setAllowNetwork] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<AnalyzeResponse | null>(null);

  const canAnalyze = file !== null && !isAnalyzing;
  const fileSummary = useMemo(() => {
    if (file === null) {
      return 'No sample selected';
    }

    return `${file.name} · ${formatBytes(file.size)}`;
  }, [file]);

  async function analyze() {
    if (file === null) {
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    setResponse(null);

    const formData = new FormData();
    formData.append('sample', file);
    formData.append('argv', argv);
    formData.append('stdin', stdin);
    formData.append('timeoutSeconds', String(timeoutSeconds));
    formData.append('memoryMb', String(memoryMb));
    formData.append('allowNetwork', String(allowNetwork));

    try {
      const result = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
      });
      const payload = (await result.json()) as AnalyzeResponse | {error: string};

      if (!result.ok) {
        throw new Error('error' in payload ? payload.error : 'Analysis failed');
      }

      setResponse(payload as AnalyzeResponse);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsAnalyzing(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Gemma 4 Binary Analysis</h1>
          <p>Upload a Linux ELF x86_64 sample and run the ADK Docker sandbox.</p>
        </div>
        <div className="status-pill">
          <ShieldCheck size={18} />
          <span>Blue team triage</span>
        </div>
      </header>

      <section className="workspace-grid">
        <form className="control-panel" onSubmit={event => event.preventDefault()}>
          <label className="upload-zone">
            <FileUp size={28} />
            <span>{fileSummary}</span>
            <input
              type="file"
              onChange={event => setFile(event.target.files?.[0] ?? null)}
            />
          </label>

          <label className="field">
            <span>argv JSON or shell words</span>
            <input value={argv} onChange={event => setArgv(event.target.value)} />
          </label>

          <label className="field">
            <span>stdin</span>
            <textarea value={stdin} onChange={event => setStdin(event.target.value)} />
          </label>

          <div className="split-fields">
            <label className="field">
              <span>Timeout</span>
              <input
                type="number"
                min={1}
                max={120}
                value={timeoutSeconds}
                onChange={event => setTimeoutSeconds(Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Memory MiB</span>
              <input
                type="number"
                min={64}
                max={1024}
                value={memoryMb}
                onChange={event => setMemoryMb(Number(event.target.value))}
              />
            </label>
          </div>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={allowNetwork}
              onChange={event => setAllowNetwork(event.target.checked)}
            />
            <Network size={18} />
            <span>Allow controlled network egress</span>
          </label>

          <button className="primary-button" type="button" disabled={!canAnalyze} onClick={analyze}>
            {isAnalyzing ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            <span>{isAnalyzing ? 'Analyzing' : 'Analyze sample'}</span>
          </button>
        </form>

        <section className="results-panel">
          {error !== null && <div className="error-banner">{error}</div>}
          {response === null && error === null && (
            <div className="empty-state">
              <Activity size={32} />
              <span>Results will appear after the sandbox run completes.</span>
            </div>
          )}
          {response !== null && <AnalysisResult response={response} />}
        </section>
      </section>
    </main>
  );
}

function AnalysisResult({response}: {response: AnalyzeResponse}) {
  const errors = response.result.errors ?? [];

  return (
    <div className="result-stack">
      <div className="summary-grid">
        <Metric label="Status" value={response.result.status ?? 'unknown'} />
        <Metric label="Run ID" value={response.result.runId ?? '-'} />
        <Metric label="Uploaded Path" value={response.upload.samplePath} />
        <Metric label="SHA-256" value={response.upload.sha256} />
      </div>

      {errors.length > 0 && (
        <div className="error-banner">{errors.join('\n')}</div>
      )}

      <div className="artifact-row">
        <Terminal size={18} />
        <span>{response.result.bundlePath ?? 'No bundle path returned'}</span>
      </div>

      <section className="report-panel">
        <h2>ADK Agent Response</h2>
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {response.agentText ?? 'No final ADK agent text returned.'}
          </ReactMarkdown>
        </div>
      </section>

      <div className="panels">
        <DataPanel title="Static Findings" value={response.result.staticFindings} />
        <DataPanel title="Runtime Findings" value={response.result.runtimeFindings} />
        <DataPanel title="Network Findings" value={response.result.networkFindings} />
        <DataPanel title="Suspicious Indicators" value={response.result.suspiciousIndicators} />
        <DataPanel title="ADK Events" value={response.adkEvents} />
      </div>

      <section className="report-panel">
        <h2>Report</h2>
        <pre>{response.reportMarkdown ?? 'No report markdown returned.'}</pre>
      </section>
    </div>
  );
}

function Metric({label, value}: {label: string; value: string}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DataPanel({title, value}: {title: string; value: unknown}) {
  return (
    <section className="data-panel">
      <h2>{title}</h2>
      <pre>{JSON.stringify(value ?? null, null, 2)}</pre>
    </section>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
