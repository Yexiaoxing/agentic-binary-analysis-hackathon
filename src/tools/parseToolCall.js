export function parseToolCall(input) {
  const openTag = '<|tool_call>';
  const closeTag = '<tool_call|>';
  const callPrefix = 'call:';

  if (!input.startsWith(openTag) || !input.endsWith(closeTag)) {
    throw new Error('Invalid tool call wrapper');
  }

  const body = input.slice(openTag.length, -closeTag.length).trim();
  if (!body.startsWith(callPrefix)) {
    throw new Error('Invalid tool call prefix');
  }

  const callBody = body.slice(callPrefix.length);
  const argsStart = callBody.indexOf('{');
  const argsEnd = callBody.lastIndexOf('}');

  if (argsStart <= 0 || argsEnd !== callBody.length - 1) {
    throw new Error('Invalid tool call arguments');
  }

  const name = callBody.slice(0, argsStart).trim();
  const argsText = callBody.slice(argsStart + 1, argsEnd).trim();

  return {
    name,
    args: parseArgs(argsText),
  };
}

function parseArgs(argsText) {
  if (argsText === '') {
    return {};
  }

  const args = {};
  const pairs = splitTopLevel(argsText, ',');

  for (const pair of pairs) {
    const separator = pair.indexOf(':');
    if (separator <= 0) {
      throw new Error(`Invalid argument pair: ${pair}`);
    }

    const key = pair.slice(0, separator).trim();
    const rawValue = pair.slice(separator + 1).trim();
    args[key] = parseValue(rawValue);
  }

  return args;
}

function parseValue(rawValue) {
  const sentinelQuote = '<|"|>';

  if (rawValue.startsWith(sentinelQuote) && rawValue.endsWith(sentinelQuote)) {
    return rawValue.slice(sentinelQuote.length, -sentinelQuote.length);
  }

  if (rawValue === 'true') {
    return true;
  }

  if (rawValue === 'false') {
    return false;
  }

  if (rawValue === 'null') {
    return null;
  }

  if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
    return Number(rawValue);
  }

  return rawValue;
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let start = 0;
  let inSentinelString = false;

  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith('<|"|>', index)) {
      inSentinelString = !inSentinelString;
      index += '<|"|>'.length - 1;
      continue;
    }

    if (!inSentinelString && text[index] === delimiter) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

const example = '<|tool_call>call:analyze_binary_behavior{samplePath:<|"|>samples/usr/bin/curl<|"|>}<tool_call|>';

console.log(parseToolCall(example));
