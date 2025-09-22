export const config = { runtime: "edge" };

// ---------- Dice faces ----------
const FACES = {
  boost: [ {s:0,a:0,t:0,f:0},{s:0,a:0,t:0,f:0},{s:1,a:0,t:0,f:0},{s:1,a:1,t:0,f:0},{s:0,a:2,t:0,f:0},{s:0,a:1,t:0,f:0} ],
  setback: [ {s:0,a:0,t:0,f:0},{s:0,a:0,t:0,f:0},{s:0,a:0,t:0,f:1},{s:0,a:0,t:0,f:1},{s:0,a:0,t:1,f:0},{s:0,a:0,t:1,f:0} ],
  ability: [ {s:0,a:0,t:0,f:0},{s:1,a:0,t:0,f:0},{s:1,a:0,t:0,f:0},{s:2,a:0,t:0,f:0},{s:0,a:1,t:0,f:0},{s:0,a:1,t:0,f:0},{s:1,a:1,t:0,f:0},{s:0,a:2,t:0,f:0} ],
  difficulty:[ {s:0,a:0,t:0,f:0},{s:0,a:0,t:0,f:1},{s:0,a:0,t:0,f:2},{s:0,a:0,t:1,f:0},{s:0,a:0,t:1,f:0},{s:0,a:0,t:1,f:0},{s:0,a:0,t:2,f:0},{s:0,a:0,t:1,f:1} ],
  proficiency:[ {s:0,a:0,t:0,f:0},{s:1,a:0,t:0,f:0},{s:1,a:0,t:0,f:0},{s:2,a:0,t:0,f:0},{s:2,a:0,t:0,f:0},{s:0,a:1,t:0,f:0},{s:1,a:1,t:0,f:0},{s:1,a:1,t:0,f:0},{s:1,a:1,t:0,f:0},{s:0,a:2,t:0,f:0},{s:0,a:2,t:0,f:0},{s:1,a:0,t:0,f:0,triumph:true} ],
  challenge:[ {s:0,a:0,t:0,f:0},{s:0,a:0,t:0,f:1},{s:0,a:0,t:0,f:1},{s:0,a:0,t:0,f:2},{s:0,a:0,t:0,f:2},{s:0,a:0,t:1,f:0},{s:0,a:0,t:1,f:0},{s:0,a:0,t:1,f:1},{s:0,a:0,t:1,f:1},{s:0,a:0,t:2,f:0},{s:0,a:0,t:2,f:0},{s:0,a:0,t:0,f:1,despair:true} ]
};
const diffMap = { Easy:1, Average:2, Hard:3, Daunting:4, Formidable:5 };

// ---------- Utils ----------
function rng(seed) {
  let s = (typeof seed === "number") ? (seed >>> 0) : Math.floor(Math.random()*2**32)>>>0;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rollFaces(type, n, r){ const a=FACES[type]; const o=[]; for(let i=0;i<n;i++) o.push(a[Math.floor(r()*a.length)]); return o; }
function buildPool(charVal, ranks){
  charVal = Math.max(0, Number(charVal)||0);
  ranks = Math.max(0, Number(ranks)||0);
  const base = Math.max(charVal, ranks);
  const upgrades = Math.min(charVal, ranks);
  return { ability: base-upgrades, proficiency: upgrades };
}
function bad(msg, code=400){ return new Response(JSON.stringify({error:msg}), {status:code, headers:{"Content-Type":"application/json"}}); }
function ok(obj){ return new Response(JSON.stringify(obj), {headers:{"Content-Type":"application/json"}}); }

// ---------- Upstash Redis ----------
async function redis(cmd, ...args){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Upstash env missing (URL or TOKEN not set)");
  }

  const body = JSON.stringify({ command: [cmd, ...args] });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body
  });

  let text;
  try {
    text = await res.text();
  } catch {
    text = "";
  }

  if (!res.ok) {
    throw new Error(`Upstash ${res.status}: ${text || "no body"}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Upstash parse error: ${text.slice(0,200)}`);
  }
}


// ---------- Index helpers ----------
async function loadIndex(){ const ix = await redis("GET","pc:index"); return ix.result ? JSON.parse(ix.result) : []; }
async function saveIndex(items){ await redis("SET","pc:index", JSON.stringify(items)); }
async function upsertIndex(id, name){
  const items = await loadIndex();
  const i = items.findIndex(x => x.id === id);
  if (i >= 0) { if (name && items[i].name !== name) { items[i].name = name; await saveIndex(items); } }
  else { items.push({ id, name: name || id }); await saveIndex(items); }
}
async function removeFromIndex(id){
  const items = await loadIndex();
  const next = items.filter(x => x.id !== id);
  if (next.length !== items.length) await saveIndex(next);
}

export default async function handler(req) {
  const url = new URL(req.url);
  const segs = url.pathname.split("/").filter(Boolean); // ["api","genesys","save"] etc.
  const op = segs[segs.length - 1];

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,x-api-key"
    }});
  }

  // Auth for all ops under /api/genesys/*
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey || apiKey !== process.env.API_KEY) return bad("unauthorized", 401);

  // --- PING (no Redis; just checks env + auth) ---
if (op === "ping" && req.method === "GET") {
  return ok({
    ok: true,
    apiKeySet: !!process.env.API_KEY,
    upstashUrlSet: !!process.env.UPSTASH_REDIS_REST_URL,
    upstashTokenSet: !!process.env.UPSTASH_REDIS_REST_TOKEN
  });
}

  // --- SAVE (upsert) ---
  if (op === "save" && req.method === "POST") {
    const body = await req.json().catch(()=>null);
    if (!body || !body.playerId || !body.character) return bad("playerId and character required");
    const id = body.playerId;
    const ch = body.character;
    const name = (ch && typeof ch.name === "string") ? ch.name : id;
    await redis("SET", `pc:${id}`, JSON.stringify(ch));
    await upsertIndex(id, name);
    return ok({ ok:true, playerId:id, name });
  }

  // --- GET ---
  if (op === "get" && req.method === "GET") {
    const playerId = url.searchParams.get("playerId");
    if (!playerId) return bad("playerId required");
    const r = await redis("GET", `pc:${playerId}`);
    if (!r.result) return ok({ exists:false, character:null });
    return ok({ exists:true, character: JSON.parse(r.result) });
  }

  // --- LIST ---
  if (op === "list" && req.method === "GET") {
    const items = await loadIndex();
    return ok({ items });
  }

  // --- DELETE ---
  if (op === "delete" && req.method === "POST") {
    const body = await req.json().catch(()=>null);
    if (!body || !body.playerId) return bad("playerId required");
    await redis("DEL", `pc:${body.playerId}`);
    await removeFromIndex(body.playerId);
    return ok({ ok:true });
  }

  // --- ROLL ---
  if (op === "roll" && req.method === "POST") {
    const body = await req.json().catch(()=>null);
    if (!body || !body.playerId || !body.skill) return bad("playerId and skill required");
    const r = await redis("GET", `pc:${body.playerId}`);
    if (!r.result) return bad("character not found", 404);
    const ch = JSON.parse(r.result);

    const entry = (ch.skills||[]).find(s => (s.name||"").toLowerCase() === (body.skill||"").toLowerCase());
    if (!entry) return bad(`skill not found: ${body.skill}`);
    const linked = entry.linked;
    const ranks = Number(entry.ranks)||0;
    const characteristic = Number((ch.characteristics||{})[linked])||0;

    let { ability, proficiency } = buildPool(characteristic, ranks);

    const difficulty = diffMap[body.difficulty] ?? 2;
    let difficultyDice = difficulty, challengeDice = 0;

    let up = Number(body.upgrades)||0, down = Number(body.downgrades)||0;
    while (up-- > 0) { if (ability>0){ ability--; proficiency++; } else { proficiency++; } }
    while (down-- > 0) { if (challengeDice>0){ challengeDice--; difficultyDice++; } else if (difficultyDice>0){ difficultyDice--; } }

    const boost = Math.max(0, Number(body.boost)||0);
    const setback = Math.max(0, Number(body.setback)||0);
    const seed = (typeof body.seed === "number") ? body.seed : null;
    const rgen = rng(seed);

    const breakdown = [];
    const push = (t, n) => { if(n>0) rollFaces(t, n, rgen).forEach(f=>breakdown.push({type:t,face:f})); };
    push("proficiency", proficiency);
    push("ability", ability);
    push("difficulty", difficultyDice);
    push("challenge", challengeDice);
    push("boost", boost);
    push("setback", setback);

    const totals = breakdown.reduce((acc, d)=>{
      acc.success += d.face.s||0;
      acc.failure += d.face.f||0;
      acc.advantage += d.face.a||0;
      acc.threat += d.face.t||0;
      if (d.face.triumph) acc.triumph += 1;
      if (d.face.despair) acc.despair += 1;
      return acc;
    }, {success:0,failure:0,advantage:0,threat:0,triumph:0,despair:0});

    const net = {
      passAxis: (totals.success + totals.triumph) - (totals.failure + totals.despair),
      netAdvantage: totals.advantage - totals.threat,
      triumph: totals.triumph,
      despair: totals.despair
    };

    return ok({
      request:{
        playerId: body.playerId,
        skill: entry.name, linked, ranks, characteristic,
        pool:{proficiency,ability,difficulty:difficultyDice,challenge:challengeDice,boost,setback},
        difficultyLabel: body.difficulty || "Average",
        upgrades: body.upgrades||0, downgrades: body.downgrades||0
      },
      totals, net, breakdown
    });
  }

  return bad("not found", 404);
}
