// VECNA — servidor na nuvem (Cloudflare Worker, grátis, sempre ligado, com https).
// Responde as mesmas rotas que server/server.js usa para notícias, música e memória.
// Gmail continua exigindo o servidor no PC de casa.
//
// Variáveis opcionais (Settings > Variables and Secrets do Worker):
//   VECNA_TOKEN      exige "Authorization: Bearer <token>" em /api/*
//   YOUTUBE_API_KEY  usa a API oficial do YouTube na busca de músicas
// Memória compartilhada (opcional): vincule um KV Namespace com o nome MEM.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]).replace(/<[^>]+>/g, '').trim() : '';
};

async function fetchNews(topic, limit) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic + ' when:2d')}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 VECNA' } });
  if (!res.ok) throw new Error(`Google News ${res.status}`);
  const xml = await res.text();
  return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0, limit).map(item => ({
    titulo: tag(item, 'title'),
    fonte: tag(item, 'source'),
    data: tag(item, 'pubDate'),
    link: tag(item, 'link')
  }));
}

async function searchMusic(q, env) {
  if (env.YOUTUBE_API_KEY) {
    const u = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&videoCategoryId=10&maxResults=5&q=${encodeURIComponent(q)}&key=${env.YOUTUBE_API_KEY}`;
    const res = await fetch(u);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error?.message || `YouTube ${res.status}`);
    return (d.items || []).map(i => ({ id: i.id.videoId, titulo: decode(i.snippet.title), canal: i.snippet.channelTitle }));
  }
  const res = await fetch('https://www.youtube.com/results?hl=pt-BR&search_query=' + encodeURIComponent(q), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36', 'Accept-Language': 'pt-BR,pt;q=0.9' }
  });
  if (!res.ok) throw new Error(`YouTube ${res.status}`);
  const html = await res.text();
  const out = [], seen = new Set();
  const re = /"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]*?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(html)) && out.length < 5) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    let titulo = m[2];
    try { titulo = JSON.parse('"' + m[2] + '"'); } catch {}
    out.push({ id: m[1], titulo, canal: '' });
  }
  if (!out.length) throw new Error('Nenhum resultado (use YOUTUBE_API_KEY).');
  return out;
}

async function loadMem(env) {
  try { const m = JSON.parse((await env.MEM.get('mem')) || '[]'); return Array.isArray(m) ? m : []; } catch { return []; }
}
const saveMem = (env, m) => env.MEM.put('mem', JSON.stringify(m.slice(-150)));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (!url.pathname.startsWith('/api/')) {
      return new Response('Servidor VECNA no ar.', { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } });
    }
    if (env.VECNA_TOKEN && req.headers.get('Authorization') !== `Bearer ${env.VECNA_TOKEN}`) {
      return json({ error: 'não autorizado' }, 401);
    }

    if (url.pathname === '/api/ping') return json({ ok: true });

    if (url.pathname === '/api/news') {
      const topics = (url.searchParams.get('topics') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
      const limit = Math.min(Number(url.searchParams.get('limit')) || 5, 10);
      if (!topics.length) return json({ error: 'informe topics' }, 400);
      const out = {};
      await Promise.all(topics.map(async t => {
        try { out[t] = await fetchNews(t, limit); } catch (e) { out[t] = { error: e.message }; }
      }));
      return json(out);
    }

    if (url.pathname === '/api/music/search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
      if (!q) return json({ error: 'informe q' }, 400);
      try { return json(await searchMusic(q, env)); } catch (e) { return json({ error: e.message }, 502); }
    }

    if (url.pathname === '/api/memory' || url.pathname === '/api/memory/forget') {
      if (!env.MEM) return json({ error: 'Memória compartilhada não configurada no Worker (KV MEM).' }, 501);
      if (url.pathname === '/api/memory') {
        if (req.method === 'POST') {
          const d = await req.json().catch(() => ({}));
          const texto = String(d.texto || '').trim().slice(0, 600);
          if (!texto) return json({ error: 'texto é obrigatório' }, 400);
          const m = await loadMem(env);
          const id = String(d.id || Date.now().toString(36)).slice(0, 32);
          if (!m.some(x => x.id === id)) m.push({ id, ts: Number(d.ts) || Date.now(), texto });
          await saveMem(env, m);
          return json({ ok: true, id });
        }
        return json(await loadMem(env));
      }
      if (req.method !== 'POST') return json({ error: 'use POST' }, 405);
      const d = await req.json().catch(() => ({}));
      const t = String(d.trecho || '').trim().toLowerCase();
      if (!t) return json({ error: 'trecho é obrigatório' }, 400);
      const m = await loadMem(env), keep = m.filter(x => !x.texto.toLowerCase().includes(t));
      await saveMem(env, keep);
      return json({ ok: true, removidas: m.length - keep.length });
    }

    if (url.pathname.startsWith('/api/mail/')) {
      return json({ error: 'Gmail só funciona com o servidor no PC de casa (server/server.js).' }, 501);
    }

    return json({ error: 'rota desconhecida' }, 404);
  }
};
