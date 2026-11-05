import http from 'node:http';

const items = [
  ['finance-1', '财经集成测试：货币政策更新', 'Finance', 9.4],
  ['technology-1', '科技集成测试：开源模型发布', 'Technology', 9.1],
  ['science-1', '科学集成测试：天文学研究进展', 'Science', 8.8],
  ['general-1', '综合集成测试：国际重大事件', 'World', 8.2],
];
const server = http.createServer((req, res) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), method: req.method, url: req.url }));
  if (req.url === '/api/v1/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: 'browser-fixture', time: new Date().toISOString() }));
    return;
  }
  if (req.url?.startsWith('/original/')) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Original article fixture: ${req.url}`);
    return;
  }
  if (req.url?.startsWith('/rss')) {
    const body = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
      <title>Newscope fixture</title>${items.map(([id, title, topic, score]) => `<item>
        <title>[${score.toFixed(1)}] ${title}</title><link>http://127.0.0.1:8081/original/${id}</link>
        <guid>${id}</guid><description>Score: ${score.toFixed(1)}/10 - integration fixture</description>
        <pubDate>${new Date().toUTCString()}</pubDate><category>${topic}</category>
      </item>`).join('')}</channel></rss>`;
    res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
    res.end(body);
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(8081, '127.0.0.1', () => console.log('mock Newscope listening on http://127.0.0.1:8081'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
