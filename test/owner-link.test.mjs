import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { launch } from './support/server.mjs';

// The tablet opens its internet link without any cloud site, and the owner's phone gets the link.
test('the tablet sends its owner link to the phone, with no cloud site needed', { timeout: 60000 }, async () => {
  // A stand-in for cloudflared that prints a link the way the real one does, then stays running.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cloudflared-'));
  fs.writeFileSync(path.join(bin, 'cloudflared'), '#!/bin/sh\necho "INF |  https://quiet-owl-test.trycloudflare.com  |" >&2\nexec sleep 600\n', { mode: 0o755 });
  // A stand-in for ntfy.sh that records what the tablet posts.
  const posts = [];
  const ntfy = http.createServer((req, res) => { let body = ''; req.on('data', (c) => (body += c)).on('end', () => { posts.push({ url: req.url, title: req.headers.title, click: req.headers.click, body }); res.end('{}'); }); });
  await new Promise((r) => ntfy.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { TUNNEL: '1', NTFY_TOPIC: 'ambiente-test-topic', NTFY_SERVER: `http://127.0.0.1:${ntfy.address().port}`, PATH: `${bin}:${process.env.PATH}` });
  delete process.env.CLOUD_URL; delete process.env.CLOUD_TOKEN;
  const server = await launch();
  try {
    for (let i = 0; i < 50 && !posts.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(posts.length, 1, 'one notification for the new link');
    assert.equal(posts[0].url, '/ambiente-test-topic');
    assert.equal(posts[0].click, 'https://quiet-owl-test.trycloudflare.com/admin');
    assert.match(posts[0].body, /quiet-owl-test\.trycloudflare\.com\/admin/);
    assert.ok(!/password|LeonesAlt|test-password/i.test(JSON.stringify(posts)), 'only the address is sent');
  } finally { await server.close(); ntfy.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});
