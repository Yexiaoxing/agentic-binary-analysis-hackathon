#!/usr/bin/env bash
set -uo pipefail

TARGET_PATH="${1:-/analysis/sample}"
shift || true

RUN_ID="${RUN_ID:-manual}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-30}"
ALLOW_NETWORK="${ALLOW_NETWORK:-false}"
STDIN_FILE="${STDIN_FILE:-/analysis/stdin.txt}"

ROOT_DIR="/analysis"
ARTIFACT_DIR="$ROOT_DIR/artifacts"
STATIC_DIR="$ARTIFACT_DIR/static"
RUNTIME_DIR="$ARTIFACT_DIR/runtime"
FS_DIR="$ARTIFACT_DIR/filesystem"
NETWORK_DIR="$ARTIFACT_DIR/network"
WORK_DIR="$ROOT_DIR/work"

mkdir -p "$STATIC_DIR" "$RUNTIME_DIR" "$FS_DIR" "$NETWORK_DIR" "$WORK_DIR"

log_cmd() {
  local output_file="$1"
  shift
  {
    printf '$'
    printf ' %q' "$@"
    printf '\n\n'
    "$@"
  } >"$output_file" 2>&1
}

safe_head() {
  local input_file="$1"
  local output_file="$2"
  local lines="${3:-2000}"
  if [[ -f "$input_file" ]]; then
    head -n "$lines" "$input_file" >"$output_file" 2>/dev/null || true
  fi
}

snapshot_tree() {
  local output_file="$1"
  {
    printf '# /analysis/work\n'
    find "$WORK_DIR" -xdev -printf '%M %s %TY-%Tm-%TdT%TH:%TM:%TS %p\n' 2>/dev/null | sort
    printf '\n# /tmp\n'
    find /tmp -xdev -printf '%M %s %TY-%Tm-%TdT%TH:%TM:%TS %p\n' 2>/dev/null | sort
  } >"$output_file"
}

if [[ ! -f "$TARGET_PATH" ]]; then
  printf '{"status":"error","error":"target file not found"}\n' >"$ROOT_DIR/report.json"
  exit 2
fi

cp "$TARGET_PATH" "$WORK_DIR/sample"
chmod 0700 "$WORK_DIR/sample" 2>/dev/null || true

{
  printf 'run_id=%s\n' "$RUN_ID"
  printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'timeout_seconds=%s\n' "$TIMEOUT_SECONDS"
  printf 'allow_network=%s\n' "$ALLOW_NETWORK"
  printf 'argv_count=%s\n' "$#"
} >"$ARTIFACT_DIR/manifest.env"

sha256sum "$WORK_DIR/sample" >"$STATIC_DIR/sha256.txt" 2>&1 || true
sha1sum "$WORK_DIR/sample" >"$STATIC_DIR/sha1.txt" 2>&1 || true
md5sum "$WORK_DIR/sample" >"$STATIC_DIR/md5.txt" 2>&1 || true
log_cmd "$STATIC_DIR/file.txt" file "$WORK_DIR/sample"
log_cmd "$STATIC_DIR/readelf-header.txt" readelf -h "$WORK_DIR/sample"
log_cmd "$STATIC_DIR/readelf-program-headers.txt" readelf -l "$WORK_DIR/sample"
log_cmd "$STATIC_DIR/readelf-sections.txt" readelf -S "$WORK_DIR/sample"
log_cmd "$STATIC_DIR/readelf-dynamic.txt" readelf -d "$WORK_DIR/sample"
log_cmd "$STATIC_DIR/symbols.txt" nm -an "$WORK_DIR/sample"
log_cmd "$STATIC_DIR/objdump-headers.txt" objdump -x "$WORK_DIR/sample"
objdump -d "$WORK_DIR/sample" >"$STATIC_DIR/disassembly.full.txt" 2>&1 || true
safe_head "$STATIC_DIR/disassembly.full.txt" "$STATIC_DIR/disassembly.head.txt" 3000
strings -a -n 4 "$WORK_DIR/sample" >"$STATIC_DIR/strings.full.txt" 2>&1 || true
safe_head "$STATIC_DIR/strings.full.txt" "$STATIC_DIR/strings.head.txt" 5000
timeout 5 ldd "$WORK_DIR/sample" >"$STATIC_DIR/ldd.txt" 2>&1 || true

snapshot_tree "$FS_DIR/before.txt"

INOTIFY_PID=""
inotifywait -m -r -e create,modify,delete,move,attrib "$WORK_DIR" /tmp \
  >"$FS_DIR/inotify.log" 2>"$FS_DIR/inotify.err" &
INOTIFY_PID="$!"

TCPDUMP_PID=""
if [[ "$ALLOW_NETWORK" == "true" ]]; then
  tcpdump -U -i any -s 0 -w "$NETWORK_DIR/capture.pcap" \
    >"$NETWORK_DIR/tcpdump.out" 2>"$NETWORK_DIR/tcpdump.err" &
  TCPDUMP_PID="$!"
  sleep 1
fi

(
  while true; do
    {
      printf -- '--- %s ---\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      ps -eo pid,ppid,stat,comm,args
      printf '\n/proc/net/tcp\n'
      cat /proc/net/tcp 2>/dev/null || true
      printf '\n/proc/net/udp\n'
      cat /proc/net/udp 2>/dev/null || true
    } >>"$RUNTIME_DIR/process-snapshots.txt"
    sleep 1
  done
) &
MONITOR_PID="$!"

EXIT_CODE=0
TIMED_OUT=false
if [[ -f "$STDIN_FILE" ]]; then
  timeout -k 2 "$TIMEOUT_SECONDS" \
    strace -ff -ttt -s 4096 -o "$RUNTIME_DIR/strace" \
    "$WORK_DIR/sample" "$@" \
    <"$STDIN_FILE" >"$RUNTIME_DIR/stdout.txt" 2>"$RUNTIME_DIR/stderr.txt"
  EXIT_CODE="$?"
else
  timeout -k 2 "$TIMEOUT_SECONDS" \
    strace -ff -ttt -s 4096 -o "$RUNTIME_DIR/strace" \
    "$WORK_DIR/sample" "$@" \
    >"$RUNTIME_DIR/stdout.txt" 2>"$RUNTIME_DIR/stderr.txt"
  EXIT_CODE="$?"
fi

if [[ "$EXIT_CODE" == "124" || "$EXIT_CODE" == "137" ]]; then
  TIMED_OUT=true
fi

timeout -k 2 10 ltrace -f -s 512 -o "$RUNTIME_DIR/ltrace.txt" \
  "$WORK_DIR/sample" "$@" \
  >"$RUNTIME_DIR/ltrace.stdout.txt" 2>"$RUNTIME_DIR/ltrace.stderr.txt" || true

kill "$MONITOR_PID" 2>/dev/null || true
if [[ -n "$INOTIFY_PID" ]]; then
  kill "$INOTIFY_PID" 2>/dev/null || true
fi
if [[ -n "$TCPDUMP_PID" ]]; then
  kill -INT "$TCPDUMP_PID" 2>/dev/null || true
  sleep 1
fi

snapshot_tree "$FS_DIR/after.txt"
diff -u "$FS_DIR/before.txt" "$FS_DIR/after.txt" >"$FS_DIR/diff.txt" 2>&1 || true

{
  printf 'exit_code=%s\n' "$EXIT_CODE"
  printf 'timed_out=%s\n' "$TIMED_OUT"
  printf 'finished_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >>"$ARTIFACT_DIR/manifest.env"

python3 - <<'PY'
import json
import os
from pathlib import Path

root = Path('/analysis')
artifacts = root / 'artifacts'

def read_text(path: Path, limit: int = 20000) -> str:
    try:
        data = path.read_text(errors='replace')
    except FileNotFoundError:
        return ''
    return data[:limit]

manifest = {}
for line in read_text(artifacts / 'manifest.env').splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        manifest[key] = value

strings = read_text(artifacts / 'static' / 'strings.head.txt')
strace = '\n'.join(
    read_text(path, 50000)
    for path in sorted((artifacts / 'runtime').glob('strace*'))
    if path.is_file()
)
ltrace = read_text(artifacts / 'runtime' / 'ltrace.txt', 50000)
fs_diff = read_text(artifacts / 'filesystem' / 'diff.txt', 50000)
file_info = read_text(artifacts / 'static' / 'file.txt')
sha256 = read_text(artifacts / 'static' / 'sha256.txt').split()

indicator_terms = {
    'network': ['connect(', 'socket(', 'sendto(', 'recvfrom(', 'getaddrinfo', 'inet_addr'],
    'process': ['execve(', 'fork(', 'clone(', 'vfork('],
    'filesystem': ['openat(', 'unlink(', 'rename(', 'chmod(', 'chown(', 'mkdir('],
    'persistence_strings': ['systemd', 'crontab', '/etc/init', '.ssh/authorized_keys'],
    'shell_strings': ['/bin/sh', '/bin/bash', 'sh -c', 'wget ', 'curl '],
}

indicators = []
combined = '\n'.join([strings, strace, ltrace, fs_diff])
for category, terms in indicator_terms.items():
    hits = sorted(term for term in terms if term in combined)
    if hits:
        indicators.append({'category': category, 'evidence': hits})

report = {
    'runId': manifest.get('run_id', 'manual'),
    'status': 'completed',
    'timedOut': manifest.get('timed_out') == 'true',
    'exitCode': int(manifest.get('exit_code', '0') or 0),
    'allowNetwork': manifest.get('allow_network') == 'true',
    'timeoutSeconds': int(manifest.get('timeout_seconds', '0') or 0),
    'hashes': {'sha256': sha256[0] if sha256 else ''},
    'staticFindings': {
        'file': file_info.strip(),
        'interestingStringsPreview': strings[:4000],
    },
    'runtimeFindings': {
        'stdoutPreview': read_text(artifacts / 'runtime' / 'stdout.txt', 4000),
        'stderrPreview': read_text(artifacts / 'runtime' / 'stderr.txt', 4000),
        'stracePreview': strace[:8000],
        'ltracePreview': ltrace[:8000],
    },
    'filesystemFindings': {'diffPreview': fs_diff[:8000]},
    'networkFindings': {
        'pcapCaptured': (artifacts / 'network' / 'capture.pcap').exists(),
        'tcpdumpError': read_text(artifacts / 'network' / 'tcpdump.err', 4000),
    },
    'suspiciousIndicators': indicators,
    'artifactPaths': {
        'manifest': 'artifacts/manifest.env',
        'static': 'artifacts/static',
        'runtime': 'artifacts/runtime',
        'filesystem': 'artifacts/filesystem',
        'network': 'artifacts/network',
    },
}

(root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')

lines = [
    f"# Binary Behavior Report: {report['runId']}",
    '',
    f"- Status: {report['status']}",
    f"- Exit code: {report['exitCode']}",
    f"- Timed out: {report['timedOut']}",
    f"- Network allowed: {report['allowNetwork']}",
    f"- SHA-256: {report['hashes']['sha256']}",
    '',
    '## Static Summary',
    '```',
    report['staticFindings']['file'][:2000],
    '```',
    '',
    '## Runtime Output',
    '```',
    (report['runtimeFindings']['stdoutPreview'] + report['runtimeFindings']['stderrPreview'])[:4000],
    '```',
    '',
    '## Filesystem Changes',
    '```diff',
    report['filesystemFindings']['diffPreview'][:4000],
    '```',
    '',
    '## Indicators',
    json.dumps(report['suspiciousIndicators'], indent=2),
    '',
]
(root / 'report.md').write_text('\n'.join(lines))
PY

exit 0
