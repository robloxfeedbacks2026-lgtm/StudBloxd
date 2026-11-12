// StudBloxd server: Lobby DO keeps the server list, one World DO per created server.
// Each World stores its seed/type and every block edit, and relays players over WebSocket.

export class Lobby {
  constructor(state) { this.s = state; }
  async fetch(req) {
    const u = new URL(req.url);
    const L = (await this.s.storage.get('l')) || {};
    if (u.pathname === '/add') {
      const m = await req.json();
      L[m.id] = { ...m, players: 0, t: Date.now() };
      const ids = Object.keys(L).sort((a, b) => L[b].t - L[a].t);
      ids.slice(200).forEach((i) => delete L[i]);
      await this.s.storage.put('l', L);
      return Response.json({ ok: 1 });
    }
    if (u.pathname === '/count') {
      const m = await req.json();
      if (L[m.id]) { L[m.id].players = m.n; await this.s.storage.put('l', L); }
      return Response.json({ ok: 1 });
    }
    return Response.json(Object.values(L).sort((a, b) => b.t - a.t).slice(0, 50));
  }
}

export class World {
  constructor(state, env) { this.s = state; this.env = env; this.pl = new Map(); this.meta = null; }
  bc(m, except) {
    const s = JSON.stringify(m);
    for (const p of this.pl.values()) if (p.id !== except) { try { p.w.send(s); } catch {} }
  }
  count() {
    const l = this.env.LOBBY.get(this.env.LOBBY.idFromName('main'));
    return l.fetch('https://l/count', { method: 'POST', body: JSON.stringify({ id: this.meta.id, n: this.pl.size }) }).catch(() => {});
  }
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/init') {
      if (!(await this.s.storage.get('meta'))) await this.s.storage.put('meta', await req.json());
      return new Response('ok');
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
    this.meta = this.meta || (await this.s.storage.get('meta'));
    if (!this.meta) return new Response('No such server', { status: 404 });
    const [c, w] = Object.values(new WebSocketPair());
    w.accept();
    const id = crypto.randomUUID().slice(0, 8);
    let me = null;
    w.addEventListener('message', async (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const okSkin = (s) => typeof s === 'string' && s.startsWith('data:image/png') && s.length < 60000 ? s : null;
      if (m.t === 'hi' && !me) {
        me = { id, w, name: String(m.name || 'Player').slice(0, 16), skin: okSkin(m.skin) };
        const edits = [...(await this.s.storage.list({ prefix: 'e:' }))].map(([k, v]) => [...k.slice(2).split(',').map(Number), v]);
        w.send(JSON.stringify({ t: 'welcome', id, meta: this.meta, edits, players: [...this.pl.values()].map((p) => ({ id: p.id, name: p.name, skin: p.skin })) }));
        this.bc({ t: 'join', id, name: me.name, skin: me.skin }, id);
        this.pl.set(id, me);
        this.count();
      } else if (me && m.t === 'p') {
        this.bc({ t: 'p', id, x: +m.x, y: +m.y, z: +m.z, ry: +m.ry, rx: +m.rx }, id);
      } else if (me && m.t === 'b') {
        const [x, y, z, b] = [m.x, m.y, m.z, m.id].map(Number);
        if (![x, y, z, b].every(Number.isInteger) || y < 0 || y >= 80 || b < 0 || b > 8 || Math.abs(x) > 1e7 || Math.abs(z) > 1e7) return;
        await this.s.storage.put(`e:${x},${y},${z}`, b);
        this.bc({ t: 'b', x, y, z, id: b }, id);
      } else if (me && m.t === 'skin') {
        me.skin = okSkin(m.skin);
        this.bc({ t: 'skin', id, skin: me.skin }, id);
      }
    });
    w.addEventListener('close', () => {
      if (me) { this.pl.delete(id); this.bc({ t: 'leave', id }); this.count(); }
    });
    return new Response(null, { status: 101, webSocket: c });
  }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const lobby = env.LOBBY.get(env.LOBBY.idFromName('main'));
    if (u.pathname === '/api/servers' && req.method === 'GET') return lobby.fetch('https://l/list');
    if (u.pathname === '/api/servers' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const id = crypto.randomUUID().slice(0, 8);
      const meta = {
        id,
        name: String(b.name || 'StudBloxd Server').slice(0, 32),
        seed: String(b.seed || Math.floor(Math.random() * 2 ** 31)).slice(0, 32),
        type: b.type === 'flat' ? 'flat' : 'normal',
      };
      await env.WORLD.get(env.WORLD.idFromName(id)).fetch('https://w/init', { method: 'POST', body: JSON.stringify(meta) });
      await lobby.fetch('https://l/add', { method: 'POST', body: JSON.stringify(meta) });
      return Response.json(meta);
    }
    if (u.pathname.startsWith('/ws/')) return env.WORLD.get(env.WORLD.idFromName(u.pathname.slice(4))).fetch(req);
    return env.ASSETS.fetch(req);
  },
};
