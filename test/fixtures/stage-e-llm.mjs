/** Local-only OpenAI Chat Completions fixture. No upstream requests, tools, or disk writes.
 * node test/fixtures/stage-e-llm.mjs (127.0.0.1:8083)
 * POST /__test/finish completes active streams; client abort removes them.
 * STAGE_E_LLM_AUTO_FINISH_MS=45000 gives timed mode; default 0 waits for finish.
 */
import http from 'node:http';
import {pathToFileURL} from 'node:url';
export const MODEL = 'stage-e-hold';
export function createFixture({autoFinishMs = 0, tickMs = 1000} = {}) {
  const active = new Map();
  const stats = {started: 0, finished: 0, aborted: 0};
  const json = (res, status, body) => {res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(body));};
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/__test/state') return json(res, 200, {...stats, active: [...active.keys()]});
    if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, {object:'list', data:[{id:MODEL, object:'model', created:0, owned_by:'stage-e-local'}]});
    if (req.method === 'POST' && url.pathname === '/__test/finish') {
      req.resume(); const count = active.size;
      for (const finish of [...active.values()]) finish();
      return json(res, 200, {finished:count});
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return json(res, 404, {error:{message:'Local fixture route not found'}});
    let body = ''; let request;
    try {
      for await (const chunk of req) {body += chunk; if (body.length > 8 * 1024 * 1024) throw new Error('Request too large');}
      request = JSON.parse(body);
    } catch {return json(res, 400, {error:{message:'Invalid request'}});}
    if (request.model !== MODEL) return json(res, 400, {error:{message:'Unknown fixture model'}});
    if (request.stream !== true) return json(res, 400, {error:{message:'Fixture requires stream:true'}});
    const id = 'chatcmpl-stage-e-' + (++stats.started);
    const created = Math.floor(Date.now()/1000);
    let timer, deadline, settled = false;
    const chunk = (delta, finish_reason = null, usage) => res.write('data: ' + JSON.stringify({id, object:'chat.completion.chunk', created, model:MODEL, choices:[{index:0, delta, finish_reason}], ...(usage ? {usage} : {})}) + '\n\n');
    const cleanup = () => {clearInterval(timer); clearTimeout(deadline); active.delete(id);};
    const finish = () => {
      if (settled) return; settled = true; cleanup(); stats.finished++;
      chunk({content:'\nStage E local fixture completed. No tools or external model calls.'});
      chunk({}, 'stop', {prompt_tokens:1, completion_tokens:1, total_tokens:2});
      res.end('data: [DONE]\n\n');
    };
    res.on('close', () => {if (!settled) {settled = true; cleanup(); stats.aborted++;}});
    res.writeHead(200, {'content-type':'text/event-stream; charset=utf-8', 'cache-control':'no-cache', 'connection':'keep-alive', 'x-accel-buffering':'no'});
    res.flushHeaders(); active.set(id, finish);
    chunk({role:'assistant', content:'Stage E local fixture running; waiting for test completion.\n'});
    timer = setInterval(() => chunk({content:'.'}), tickMs);
    if (autoFinishMs > 0) deadline = setTimeout(finish, autoFinishMs);
  });
  return {server, stats, active};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.STAGE_E_LLM_PORT || 8083);
  const autoFinishMs = Number(process.env.STAGE_E_LLM_AUTO_FINISH_MS || 0);
  const {server} = createFixture({autoFinishMs});
  server.listen(port, '127.0.0.1', () => console.log('Stage E local LLM http://127.0.0.1:' + port + '; finish=' + (autoFinishMs || 'POST /__test/finish')));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {server.closeAllConnections(); server.close();});
}
