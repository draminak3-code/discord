import WebSocket from 'ws';
const BASE = 'http://localhost:3000/api';

// 1. register + login (REST)
const reg = await fetch(`${BASE}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'secret123' }) });
const { token, user } = await reg.json();
console.log('register:', reg.status, user.username);
const hdr = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

// 2. list guilds & channels
const guilds = await (await fetch(`${BASE}/guilds`, { headers: hdr })).json();
console.log('guilds:', guilds.map(g => g.name));
const gid = guilds[0].id;
const chans = await (await fetch(`${BASE}/guilds/${gid}/channels`, { headers: hdr })).json();
console.log('channels:', chans.map(c => `${c.type}:${c.name}`));
const textCh = chans.find(c => c.type === 'text');

// 3. rate-limit headers present?
const histRes = await fetch(`${BASE}/channels/${textCh.id}/messages?limit=100`, { headers: hdr });
console.log('history status:', histRes.status, '| X-RateLimit-Limit:', histRes.headers.get('x-ratelimit-limit'), '| Remaining:', histRes.headers.get('x-ratelimit-remaining'));

// 4. WebSocket gateway flow
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://localhost:3000/ws?token=${token}`);
  let sessionId = null, seq = 0, gotHello = false, gotReady = false, gotMsgCreate = false, gotAck = false;
  ws.on('message', async (raw) => {
    const p = JSON.parse(raw);
    if (p.op === 10) { gotHello = true; console.log('HELLO heartbeat_interval=', p.d.heartbeat_interval);
      ws.send(JSON.stringify({ op: 2, d: { token, intents: 513 } })); }
    else if (p.op === 0 && p.t === 'READY') { gotReady = true; sessionId = p.d.session_id; seq = p.s;
      console.log('READY session_id=', sessionId.slice(0,8), 'seq=', seq);
      // send a message over REST → should arrive as MESSAGE_CREATE via pub/sub
      fetch(`${BASE}/channels/${textCh.id}/messages`, { method: 'POST', headers: hdr, body: JSON.stringify({ content: 'hello realtime world' }) }).then(r => r.json());
      // heartbeat op1 → expect ACK op11
      ws.send(JSON.stringify({ op: 1, d: seq })); }
    else if (p.op === 11) { gotAck = true; console.log('HEARTBEAT_ACK received'); }
    else if (p.op === 0 && p.t === 'MESSAGE_CREATE') { gotMsgCreate = true; seq = p.s;
      console.log('MESSAGE_CREATE via WS:', p.d.content); }
  });
  ws.on('close', (code) => console.log('ws closed code', code));
  setTimeout(() => {
    console.log('PROTOCOL CHECK:', { gotHello, gotReady, gotAck, gotMsgCreate });
    if (!gotMsgCreate) reject(new Error('no realtime relay'));
    else resolve();
  }, 1500);
});

// 5. resume flow: reconnect with session id
await new Promise((resolve) => {
  const ws2 = new WebSocket(`ws://localhost:3000/ws?token=${token}`);
  ws2.on('message', (raw) => {
    const p = JSON.parse(raw);
    if (p.op === 10) ws2.send(JSON.stringify({ op: 6, d: { token, session_id: 'bogus', seq: 0 } }));
    else if (p.op === 9) { console.log('INVALID_SESSION for unknown resume id (expected):', p.d); ws2.close(); resolve(); }
  });
  setTimeout(resolve, 1200);
});

// 6. create channel via REST (POST /channels example from docs)
const created = await fetch(`${BASE}/guilds/${gid}/channels`, { method: 'POST', headers: hdr, body: JSON.stringify({ name: 'engineering', type: 'text' }) });
console.log('create channel:', created.status);

// 7. permissions check — tester has no MANAGE_GUILD on demo server? try rename
const patch = await fetch(`${BASE}/guilds/${gid}`, { method: 'PATCH', headers: hdr, body: JSON.stringify({ name: 'hacked' }) });
console.log('rename without MANAGE_GUILD →', patch.status, '(403 expected for non-admin)');

// 8. webhook roundtrip
const hook = await (await fetch(`${BASE}/channels/${textCh.id}/webhooks`, { method: 'POST', headers: hdr, body: JSON.stringify({ name: 'CI notify' }) })).json();
const whPost = await fetch(`${BASE}/webhooks/${hook.id}/${hook.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'build passed ✔' }) });
console.log('webhook POST:', whPost.status);
process.exit(0);
