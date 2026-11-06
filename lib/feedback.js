import { normalizeNewscopeUrl } from './article-identity.js';

const ACTIONS = new Set(['like', 'dislike']);
const KEY_PATTERN = /^(?:url:[a-f0-9]{64}:[a-f0-9]{64}|newscope:[a-f0-9]{64}:[1-9]\d{0,18})$/;

function failure(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function normalizeFeedbackRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || typeof value.articleKey !== 'string'
    || !KEY_PATTERN.test(value.articleKey) || !ACTIONS.has(value.action)) {
    throw failure(400, 'Expected exactly articleKey and action: like or dislike');
  }
  return { articleKey: value.articleKey, action: value.action };
}

async function targetDetails(candidateStore, config, articleKey) {
  const snapshot = await candidateStore.snapshot(config.newscopeUrl, { maxAgeHours: 720 });
  for (const article of snapshot.articles) {
    const aliases = snapshot.aliasesByKey[article.articleKey] || [];
    if (article.articleKey !== articleKey && !aliases.includes(articleKey)) continue;
    if (!article.newscopeId) throw failure(422, 'This article has no resolved Newscope ID');
    return { articleKey: article.articleKey, newscopeId: article.newscopeId, currentFeedback: article.feedback };
  }
  throw failure(404, 'Feedback article was not found in the candidate inventory');
}

export async function submitNewscopeFeedback({ fetch, candidateStore, config, input, timeoutMs = 10000 }) {
  const { articleKey, action } = normalizeFeedbackRequest(input);
  const target = await targetDetails(candidateStore, config, articleKey);
  if (target.currentFeedback === action) {
    return { ok: true, articleKey: target.articleKey, action, duplicate: true, statePersisted: true };
  }
  const source = normalizeNewscopeUrl(config.newscopeUrl);
  if (!source) throw failure(500, 'Invalid Newscope URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(source + '/api/v1/feedback/' + target.newscopeId + '/' + action, {
      method: 'POST', headers: { accept: 'text/html' }, redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) throw failure(502, 'Newscope feedback returned HTTP ' + response.status);
    // Newscope returns an article-card HTML fragment. Never parse or inject it.
    await response.body?.cancel().catch(() => {});
  } catch (error) {
    if (controller.signal.aborted) throw failure(504, 'Newscope feedback timed out');
    if (Number.isInteger(error?.statusCode)) throw error;
    throw failure(502, 'Could not reach Newscope feedback endpoint');
  } finally {
    clearTimeout(timer);
  }
  let statePersisted = true;
  try {
    await candidateStore.recordFeedback(config.newscopeUrl, target.articleKey, action);
  } catch {
    // The remote feedback is already committed. A 5xx here could cause a retry and
    // another native score adjustment, so acknowledge it with an explicit warning.
    statePersisted = false;
  }
  return { ok: true, articleKey: target.articleKey, action, duplicate: false, statePersisted };
}
