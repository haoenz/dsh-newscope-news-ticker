export function parseModelRoute(value, field = 'translationModel') {
  const route = String(value || '').trim();
  const separator = route.indexOf('/');
  if (separator < 1 || separator === route.length - 1) {
    throw new Error(field + ' must use the DSH provider/model form, for example kt/deepseek-flash');
  }
  return { provider: route.slice(0, separator), model: route.slice(separator + 1), route };
}

function parseJsonText(value) {
  let text = String(value || '').trim();
  const fence = String.fromCharCode(96).repeat(3);
  if (text.startsWith(fence)) {
    text = text.slice(fence.length).replace(/^json\s*/i, '');
    if (text.endsWith(fence)) text = text.slice(0, -fence.length);
    text = text.trim();
  }
  return JSON.parse(text);
}

export async function requestDshJson({ llm, modelRoute, system, input, maxTokens = 2000, timeoutMs = 45_000 }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('DSH LLM service is unavailable');
  const route = parseModelRoute(modelRoute);
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }],
    temperature: 0,
    maxTokens,
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
  const blocks = new Map();
  let finishReason;
  for await (const chunk of stream) {
    if (chunk.type === 'block-start' && chunk.blockType === 'text' && !blocks.has(chunk.index)) {
      blocks.set(chunk.index, { text: '' });
    }
    if (chunk.type === 'text-delta') {
      const block = blocks.get(chunk.index) || { text: '' };
      block.text += chunk.text;
      blocks.set(chunk.index, block);
    }
    if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      blocks.set(chunk.index, { text: chunk.block.text });
    }
    if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) {
      throw new Error('Model JSON response must contain text only');
    }
    if (chunk.type === 'finish') {
      finishReason = chunk.reason;
      break;
    }
  }
  if (!finishReason) throw new Error('Model stream ended without a finish reason');
  if (finishReason.kind === 'error' || finishReason.kind === 'aborted') {
    throw new Error('DSH model request failed: ' + finishReason.failure.message);
  }
  if (finishReason.kind !== 'stop') throw new Error('Model stream ended with ' + finishReason.kind);
  const text = [...blocks.entries()].sort((left, right) => left[0] - right[0]).map(([, block]) => block.text).join('');
  return parseJsonText(text);
}
