import { defineConfig } from 'vite';

// The page may stop only the local Vite process that served it. Remote visitors
// and pages from another origin cannot call this endpoint.
function localShutdown(server) {
  server.middlewares.use((req, res, next) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path !== '/__local/status' && path !== '/__local/shutdown') return next();

    const address = req.socket.remoteAddress || '';
    const host = req.headers.host || '';
    const localAddress = address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
    const sameOrigin = req.headers.origin === `http://${host}`;
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (!localAddress || !localHost) return send(403, { error: '仅限本机使用' });
    if (path === '/__local/status' && req.method === 'GET') return send(200, { local: true });
    if (path !== '/__local/shutdown' || req.method !== 'POST' || !sameOrigin) {
      return send(403, { error: '请求未获准' });
    }
    send(200, { closing: true });
    setTimeout(() => {
      server.httpServer.close();
      setTimeout(() => process.exit(0), 150);
    }, 150);
  });
}

export default defineConfig({
  plugins: [{ name: 'local-page-shutdown', configureServer: localShutdown, configurePreviewServer: localShutdown }],
});
