// LAST BATTLE
// 하나의 Cloudflare Worker가 화면(GET /), API(POST /), 자동 수집(Cron)을 모두 처리한다.
//
// 데이터 흐름
//  - 영웅 총투력 : LastAsylum.gg 서버별 공개 랭킹(상위 100명)을 Cron이 주기적으로 읽어 D1에 저장한다.
//                  Tracker API는 차감되지 않는다. 사용자가 "갱신"을 누른 유저만 Tracker로 다시 읽는다.
//  - 활동성      : 랭킹에 등장한 길드를 Tracker 길드 API로 하루 한 번 읽어 전체 투력 변동을 기록한다.
//  - 화면        : 저장된 데이터만 읽는다. 접속·검색·서버 선택으로는 Tracker API가 차감되지 않는다.

const SERVER_MIN = 225;
const SERVER_MAX = 256;
const UA = "LastBattle/1.0";
const TRACKER = "https://api.lastasylumtracker.com/v1/";
const rankingUrl = (server) => "https://lastasylum.gg/en/leaderboard/servers/" + server + "/heroes";

const HOUR = 3600;
const DAY = 86400;
const RANK_INTERVAL = 12 * HOUR; // 서버별 공개 랭킹 자동 수집 주기
const RANK_RETRY = HOUR; // 자동 수집 실패 후 재시도 간격
const RANK_MANUAL_GAP = 300; // 같은 서버 수동 새로고침 최소 간격
const RANKS_PER_TICK = 1; // Cron 1회당 랭킹 수집 서버 수 (무료 플랜 CPU 한도 고려)
const MIN_RANK_ROWS = 10; // 이보다 적게 읽히면 페이지 구조 변경으로 보고 저장하지 않는다
const GUILD_INTERVAL = 23 * HOUR; // 길드별 전체 투력 수집 주기
const GUILDS_PER_TICK = 4;
const AUTO_BUDGET = 320; // 자동 수집이 하루에 쓸 수 있는 Tracker 조회 수
const RESERVE = 50; // 오류·예비용으로 남겨 두는 조회 수
const DEFAULT_LIMIT = 1000;
const SESSION_DAYS = 30;
const MAX_LOAD_SERVERS = 8; // 한 번의 요청으로 내려보내는 서버 수
const LAZY_RANKS = 2; // 화면 요청 중 즉시 수집해 주는 미수집 서버 수

const SCHEMA_VERSION = "2";
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS players(uid TEXT PRIMARY KEY,server INTEGER NOT NULL,nick TEXT NOT NULL,guild TEXT NOT NULL DEFAULT '',total INTEGER,hero INTEGER,total_at INTEGER,baseline_at INTEGER,hero_at INTEGER,first_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS wiki_ranks(uid TEXT PRIMARY KEY,server INTEGER NOT NULL,hero INTEGER NOT NULL,rank INTEGER NOT NULL,read_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS servers(server INTEGER PRIMARY KEY,rank_at INTEGER,rank_try_at INTEGER,rank_count INTEGER,rank_error TEXT)",
  "CREATE TABLE IF NOT EXISTS guilds(server INTEGER NOT NULL,tag TEXT NOT NULL,ranked INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,fetched_at INTEGER,fails INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(server,tag))",
  "CREATE TABLE IF NOT EXISTS quota(day TEXT PRIMARY KEY,lim INTEGER NOT NULL,remaining INTEGER NOT NULL,auto_used INTEGER NOT NULL DEFAULT 0,manual_used INTEGER NOT NULL DEFAULT 0)",
];
// 이전 버전이 만든 players 테이블에 없을 수 있는 열. 없으면 추가한다(기존 데이터는 그대로 둔다).
const PLAYER_COLUMNS = {
  guild: "TEXT NOT NULL DEFAULT ''",
  total: "INTEGER",
  hero: "INTEGER",
  total_at: "INTEGER", // 전체 투력을 마지막으로 관측한 시각
  baseline_at: "INTEGER", // 현재 전체 투력 값을 처음 관측한 시각
  hero_at: "INTEGER", // Tracker로 영웅 총투력을 읽은 시각
  first_at: "INTEGER", // 전체 투력을 처음 관측한 시각 (baseline_at과 같으면 아직 변동을 본 적이 없다)
};
const INDEXES = [
  "CREATE INDEX IF NOT EXISTS players_server ON players(server)",
  "CREATE INDEX IF NOT EXISTS wiki_ranks_server ON wiki_ranks(server)",
];

// Tracker로 읽은 값과 공개 랭킹 값 중 더 최근에 읽은 쪽을 영웅 총투력으로 쓴다.
const FROM_TRACKER = "(p.hero IS NOT NULL AND p.hero_at IS NOT NULL AND (w.read_at IS NULL OR p.hero_at>=w.read_at))";
const SELECT_ROW =
  "SELECT p.uid,p.server,p.nick,p.guild,w.rank," +
  "CASE WHEN " + FROM_TRACKER + " THEN p.hero ELSE w.hero END AS hero," +
  "CASE WHEN " + FROM_TRACKER + " THEN p.hero_at ELSE w.read_at END AS hero_at," +
  "CASE WHEN " + FROM_TRACKER + " THEN 'tracker' ELSE 'rank' END AS src," +
  "p.total_at,p.baseline_at,p.first_at " +
  "FROM players p LEFT JOIN wiki_ranks w ON w.uid=p.uid AND w.server=p.server";

// ?1 uid ?2 server ?3 nick ?4 guild ?5 total ?6 hero ?7 전체 투력 관측 시각 ?8 영웅 투력 관측 시각
const UPSERT_PLAYER =
  "INSERT INTO players(uid,server,nick,guild,total,hero,total_at,baseline_at,first_at,hero_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7,?7,?8) " +
  "ON CONFLICT(uid) DO UPDATE SET server=excluded.server,nick=excluded.nick," +
  "guild=CASE WHEN excluded.guild='' THEN players.guild ELSE excluded.guild END," +
  "first_at=CASE WHEN excluded.total IS NULL THEN players.first_at ELSE COALESCE(players.first_at,players.baseline_at,excluded.total_at) END," +
  "baseline_at=CASE WHEN excluded.total IS NULL THEN players.baseline_at WHEN players.total IS NULL OR players.total!=excluded.total THEN excluded.total_at ELSE COALESCE(players.baseline_at,excluded.total_at) END," +
  "total=COALESCE(excluded.total,players.total),total_at=COALESCE(excluded.total_at,players.total_at)," +
  "hero=COALESCE(excluded.hero,players.hero),hero_at=CASE WHEN excluded.hero IS NULL THEN players.hero_at ELSE excluded.hero_at END";

// 길드원 전체 투력 반영. 이미 저장된 유저(랭킹에 올랐거나 직접 조회한 유저)만 갱신한다.
// ?1 [{u,p}] JSON ?2 관측 시각 ?3 길드 태그 ?4 서버
const UPDATE_TOTALS =
  "UPDATE players SET guild=?3,first_at=COALESCE(first_at,baseline_at,?2)," +
  "baseline_at=CASE WHEN total IS NULL OR total!=j.p THEN ?2 ELSE COALESCE(baseline_at,?2) END," +
  "total=j.p,total_at=?2 " +
  "FROM (SELECT json_extract(value,'$.u') AS u,json_extract(value,'$.p') AS p FROM json_each(?1)) AS j " +
  "WHERE players.uid=j.u AND players.server=?4 AND (players.total_at IS NULL OR players.total_at<?2)";

class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

const HEAD = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};
const reply = (data, status = 200) => Response.json(data, { status, headers: HEAD });
const now = () => Math.floor(Date.now() / 1000);
const day = () => new Date(Date.now()).toISOString().slice(0, 10); // Tracker 한도는 UTC 00:00에 초기화된다
const validServer = (s) => Number.isInteger(s) && s >= SERVER_MIN && s <= SERVER_MAX;
const UID = /^\d{1,20}$/;

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replaceAll(",", ""));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------- DB 준비

let schemaReady = false;

async function getMeta(env, k) {
  return (await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(k).first())?.v;
}

async function setMeta(env, k, v) {
  await env.DB.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(v)).run();
}

async function init(env) {
  if (schemaReady) return;
  let version;
  try {
    version = await getMeta(env, "schema");
  } catch {
    version = undefined; // meta 테이블이 아직 없다
  }
  if (version !== SCHEMA_VERSION) {
    await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
    const have = new Set((await env.DB.prepare("PRAGMA table_info(players)").all()).results.map((c) => c.name));
    for (const [name, type] of Object.entries(PLAYER_COLUMNS)) {
      if (have.has(name)) continue;
      try {
        await env.DB.prepare("ALTER TABLE players ADD COLUMN " + name + " " + type).run();
      } catch (err) {
        if (!/duplicate column/i.test(String(err?.message))) throw err; // 동시에 들어온 요청이 먼저 추가한 경우는 넘어간다
      }
    }
    const servers = [];
    for (let s = SERVER_MIN; s <= SERVER_MAX; s++) servers.push("(" + s + ")");
    await env.DB.batch([
      ...INDEXES.map((s) => env.DB.prepare(s)),
      env.DB.prepare("INSERT OR IGNORE INTO servers(server) VALUES " + servers.join(",")),
    ]);
    await setMeta(env, "schema", SCHEMA_VERSION);
  }
  schemaReady = true;
}

// ---------------------------------------------------------------- 인증

const encoder = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unb64url = (s) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

// 세션 서명 키. 비밀번호만으로 만들지 않고 API 키를 섞어, 토큰이 노출돼도 비밀번호를 역산하기 어렵게 한다.
async function sessionKey(env) {
  const material = encoder.encode("lb-session\n" + env.ADMIN_PASSWORD + "\n" + env.TRACKER_API_KEY);
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function issueToken(env) {
  const exp = now() + SESSION_DAYS * DAY;
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(env), encoder.encode("lb:" + exp));
  return exp + "." + b64url(sig);
}

async function checkToken(env, token) {
  const m = /^(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(typeof token === "string" ? token : "");
  if (!m || Number(m[1]) <= now()) return false;
  return crypto.subtle.verify("HMAC", await sessionKey(env), unb64url(m[2]), encoder.encode("lb:" + m[1]));
}

// 길이·내용에 따라 비교 시간이 달라지지 않도록 해시끼리 비교한다.
async function checkPassword(env, password) {
  if (typeof password !== "string" || !password || password.length > 200) return false;
  const [a, b] = await Promise.all(
    [password, env.ADMIN_PASSWORD].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)))),
  );
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------- Tracker API와 하루 한도

// 조회 전에 한 건을 원자적으로 차감해 둔다. 여러 요청이 동시에 들어와도 보호선을 넘지 않는다.
//  - auto   : 자동 수집. 하루 AUTO_BUDGET 건까지, 예비(RESERVE)는 남긴다.
//  - manual : 사용자 요청. 자동 수집이 아직 쓰지 않은 몫과 예비는 건드리지 않는다.
async function reserve(env, kind) {
  const d = day();
  const take =
    kind === "auto"
      ? "UPDATE quota SET remaining=remaining-1,auto_used=auto_used+1 WHERE day=?1 AND remaining>?2 AND auto_used<?3 RETURNING remaining"
      : "UPDATE quota SET remaining=remaining-1,manual_used=manual_used+1 WHERE day=?1 AND remaining>?2+MAX(0,?3-auto_used) RETURNING remaining";
  const [, taken] = await env.DB.batch([
    env.DB
      .prepare("INSERT OR IGNORE INTO quota(day,lim,remaining) SELECT ?1,l,l FROM (SELECT COALESCE((SELECT lim FROM quota ORDER BY day DESC LIMIT 1),?2) AS l)")
      .bind(d, DEFAULT_LIMIT),
    env.DB.prepare(take).bind(d, RESERVE, AUTO_BUDGET),
  ]);
  if (!taken.results.length) {
    throw new AppError(
      kind === "auto" ? "오늘 자동 수집 한도 도달" : "오늘 수동 조회 한도에 도달했습니다 (자동 수집·예비분 보호). 한국 시간 오전 9시에 초기화됩니다.",
      429,
    );
  }
}

// Tracker가 알려 준 실제 잔여 횟수로 맞춘다.
async function syncQuota(env, res, body) {
  const remaining = num(res.headers.get("X-RateLimit-Remaining")) ?? num(body?.quota?.remaining);
  if (remaining === null) return;
  const limit = num(res.headers.get("X-RateLimit-Limit")) ?? num(body?.quota?.limit);
  try {
    await env.DB.prepare("UPDATE quota SET remaining=?2,lim=COALESCE(?3,lim) WHERE day=?1").bind(day(), remaining, limit).run();
  } catch (err) {
    console.error("quota sync failed", err);
  }
}

// 리다이렉트는 같은 주소(https, 같은 호스트)일 때만 따라간다. API 키가 다른 곳으로 전달되지 않게 한다.
async function trackerFetch(env, path) {
  let url = new URL(TRACKER + path);
  const headers = { Authorization: "Bearer " + env.TRACKER_API_KEY, "User-Agent": UA, Accept: "application/json" };
  for (let hop = 0; hop < 4; hop++) {
    let res;
    try {
      res = await fetch(url.href, { headers, redirect: "manual", signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new AppError("Tracker 연결 실패: " + (err?.name === "TimeoutError" ? "응답 시간 초과" : "외부 요청 오류"), 502);
    }
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get("Location");
    if (!location) throw new AppError("Tracker 응답 주소 오류", 502);
    const next = new URL(location, url);
    if (next.origin !== url.origin) throw new AppError("Tracker가 다른 주소로 이동을 요구해 중단했습니다", 502);
    url = next;
  }
  throw new AppError("Tracker 주소 이동 횟수 초과", 502);
}

const TRACKER_ERRORS = {
  401: "Tracker API 키 인증 실패 · Cloudflare Secret(TRACKER_API_KEY)을 확인해 주세요",
  404: "Tracker에서 대상을 찾지 못했습니다 · 서버 번호와 이름을 확인해 주세요",
  409: "같은 이름이 여러 개라 특정할 수 없습니다",
  429: "오늘 Tracker API 한도를 모두 사용했습니다",
};

async function tracker(env, path, kind) {
  await reserve(env, kind);
  const res = await trackerFetch(env, path);
  let body = null;
  try {
    body = await res.json();
  } catch {}
  await syncQuota(env, res, body);
  if (!res.ok) {
    const known = TRACKER_ERRORS[res.status];
    throw new AppError(known ?? "Tracker 조회 실패 (HTTP " + res.status + ") · 잠시 후 다시 시도해 주세요", known ? res.status : 502);
  }
  if (!body || typeof body !== "object" || body.ok === false) throw new AppError("Tracker 응답 형식 오류", 502);
  return body;
}

// 응답이 캐시본이면 age_seconds만큼 과거에 관측된 값이다.
function observedAt(body) {
  const age = num(body.age_seconds);
  return now() - (age === null ? 0 : Math.min(age, 30 * DAY));
}

function pickPlayer(body) {
  for (const o of [body, body.player, body.profile, body.data]) {
    if (o && typeof o === "object" && !Array.isArray(o) && (o.uid ?? o.player_id) != null) return o;
  }
  return null;
}

function roster(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (Array.isArray(o.members)) return o.members;
  for (const v of Object.values(o)) {
    const r = roster(v);
    if (r) return r;
  }
  return null;
}

// 유저 한 명을 Tracker에서 읽어 저장한다 (API 1회).
async function refreshPlayer(env, path, expectServer) {
  const body = await tracker(env, "players/" + path + "?fresh=1", "manual");
  const p = pickPlayer(body);
  const uid = String(p?.uid ?? p?.player_id ?? "");
  const nick = String(p?.nick_name ?? p?.nick ?? p?.name ?? "").trim();
  if (!UID.test(uid) || !nick) throw new AppError("Tracker 응답에 유저 정보가 없습니다", 502);
  const server = Number(p.kid ?? p.sid ?? p.server ?? expectServer);
  if (!validServer(server)) throw new AppError("#" + server + " 서버 유저입니다 (지원 범위 " + SERVER_MIN + "~" + SERVER_MAX + ")", 404);
  if (expectServer && server !== expectServer) throw new AppError("#" + expectServer + " 서버가 아니라 #" + server + " 서버 유저가 조회되었습니다", 404);
  const total = num(p.power);
  const hero = num(p.ranks?.heroes?.score ?? body.ranks?.heroes?.score);
  const guild = String(p.alliance_abbr ?? p.union_abbr ?? "").replace(/^\[|\]$/g, "");
  const t = observedAt(body);
  await env.DB.prepare(UPSERT_PLAYER).bind(uid, server, nick, guild, total, hero, total === null ? null : t, hero === null ? null : t).run();
  return { uid, hero };
}

// 길드 한 곳의 전체 투력을 읽어 반영한다 (API 1회, 자동 수집 몫에서 차감).
async function collectGuild(env, server, tag) {
  const body = await tracker(env, "alliances/" + server + "/" + encodeURIComponent(tag) + "?fresh=1", "auto");
  const members = roster(body);
  if (!members || !members.length) throw new AppError("길드원 정보 없음", 502);
  const rows = [];
  for (const m of members) {
    const u = String(m?.uid ?? m?.player_id ?? "");
    const p = num(m?.power);
    if (UID.test(u) && p !== null) rows.push({ u, p });
  }
  if (!rows.length) throw new AppError("길드원 전체 투력 정보 없음", 502);
  await env.DB.prepare(UPDATE_TOTALS).bind(JSON.stringify(rows), observedAt(body), tag, server).run();
  return rows.length;
}

// ---------------------------------------------------------------- 공개 랭킹

function plain(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, x) => {
      if (x[0] === "#") {
        const n = x[1].toLowerCase() === "x" ? parseInt(x.slice(2), 16) : Number(x.slice(1));
        return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
      }
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[x.toLowerCase()] ?? "";
    })
    .trim();
}

// 랭킹 표의 각 행: 순위 | <a href=".../leaderboard/player/{uid}">닉네임</a> | [길드] | 영웅 총투력
function parseRanking(html) {
  const start = html.indexOf("<table");
  const end = start < 0 ? -1 : html.indexOf("</table>", start);
  const table = end > start ? html.slice(start, end) : html;
  const rows = [];
  const seen = new Set();
  for (const m of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    if (cells.length !== 3 && cells.length !== 4) continue;
    const rank = Number(plain(cells[0]));
    const link = cells[1].match(
      /<a\b[^>]*href\s*=\s*["'](?:https:\/\/lastasylum\.gg)?\/(?:[a-z]{2}\/)?leaderboard\/player\/(\d{1,20})(?:[?#][^"']*)?["'][^>]*>([\s\S]*?)<\/a>/i,
    );
    const hero = num(plain(cells[cells.length - 1]));
    if (!link || !Number.isInteger(rank) || rank < 1 || rank > 100 || !hero || seen.has(link[1])) continue;
    const nick = plain(link[2]);
    if (!nick) continue;
    const guild = cells.length === 4 ? plain(cells[2]).replace(/^\[|\]$/g, "") : "";
    rows.push({ uid: link[1], nick, guild, hero, rank });
    seen.add(link[1]);
  }
  return rows.sort((a, b) => a.rank - b.rank);
}

// 서버 한 곳의 공개 영웅 랭킹을 읽어 저장한다. Tracker API는 쓰지 않는다.
async function collectRanking(env, server) {
  const t = now();
  try {
    let res;
    try {
      res = await fetch(rankingUrl(server), { headers: { Accept: "text/html", "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      throw new AppError("원본 랭킹 연결 실패: " + (err?.name === "TimeoutError" ? "응답 시간 초과" : "외부 요청 오류"), 502);
    }
    if (!res.ok) throw new AppError("원본 랭킹 접근 불가 (HTTP " + res.status + ")", 502);
    const rows = parseRanking(await res.text());
    if (rows.length < MIN_RANK_ROWS) throw new AppError("원본 랭킹 표를 읽지 못했습니다 (" + rows.length + "명 · 페이지 구조 변경 가능)", 502);

    const tags = new Map();
    for (const r of rows) if (r.guild) tags.set(r.guild, (tags.get(r.guild) ?? 0) + 1);
    const players = JSON.stringify(rows.map((r) => ({ u: r.uid, n: r.nick, g: r.guild, h: r.hero, r: r.rank })));
    const guilds = JSON.stringify([...tags].map(([tag, n]) => ({ t: tag, n })));
    await env.DB.batch([
      env.DB
        .prepare(
          "INSERT INTO players(uid,server,nick,guild) SELECT json_extract(value,'$.u'),?2,json_extract(value,'$.n'),json_extract(value,'$.g') FROM json_each(?1) WHERE true " +
            "ON CONFLICT(uid) DO UPDATE SET server=excluded.server,nick=excluded.nick,guild=excluded.guild " +
            "WHERE players.server IS NOT excluded.server OR players.nick IS NOT excluded.nick OR players.guild IS NOT excluded.guild",
        )
        .bind(players, server),
      env.DB
        .prepare(
          "INSERT INTO wiki_ranks(uid,server,hero,rank,read_at) SELECT json_extract(value,'$.u'),?2,json_extract(value,'$.h'),json_extract(value,'$.r'),?3 FROM json_each(?1) WHERE true " +
            "ON CONFLICT(uid) DO UPDATE SET server=excluded.server,hero=excluded.hero,rank=excluded.rank,read_at=excluded.read_at",
        )
        .bind(players, server, t),
      // 상위 100위 밖으로 밀려난 유저의 옛 순위는 지운다.
      env.DB.prepare("DELETE FROM wiki_ranks WHERE server=?1 AND read_at<?2").bind(server, t),
      // 길드 수집 우선순위(ranked)는 랭킹에 오른 인원 수로 정한다.
      env.DB
        .prepare("UPDATE guilds SET ranked=0 WHERE server=?1 AND ranked!=0 AND tag NOT IN (SELECT json_extract(value,'$.t') FROM json_each(?2))")
        .bind(server, guilds),
      env.DB
        .prepare(
          "INSERT INTO guilds(server,tag,ranked) SELECT ?1,json_extract(value,'$.t'),json_extract(value,'$.n') FROM json_each(?2) WHERE true " +
            "ON CONFLICT(server,tag) DO UPDATE SET ranked=excluded.ranked WHERE guilds.ranked!=excluded.ranked",
        )
        .bind(server, guilds),
      env.DB.prepare("UPDATE servers SET rank_at=?2,rank_try_at=?2,rank_count=?3,rank_error=NULL WHERE server=?1").bind(server, t, rows.length),
    ]);
    return rows.length;
  } catch (err) {
    const message = err instanceof AppError ? err.message : "저장 실패: " + String(err?.message ?? err);
    try {
      await env.DB.prepare("UPDATE servers SET rank_try_at=?2,rank_error=?3 WHERE server=?1").bind(server, t, message.slice(0, 200)).run();
    } catch {}
    throw err instanceof AppError ? err : new AppError("#" + server + " 랭킹 " + message, 500);
  }
}

// ---------------------------------------------------------------- 조회

async function quotaInfo(env) {
  const q = await env.DB.prepare("SELECT day,lim,remaining,auto_used,manual_used FROM quota ORDER BY day DESC LIMIT 1").first();
  const today = !!q && q.day === day();
  const limit = q?.lim ?? DEFAULT_LIMIT;
  const remaining = today ? q.remaining : limit;
  const autoUsed = today ? q.auto_used : 0;
  return {
    limit,
    remaining,
    autoUsed,
    autoBudget: AUTO_BUDGET,
    manualUsed: today ? q.manual_used : 0,
    manualLeft: Math.max(0, remaining - RESERVE - Math.max(0, AUTO_BUDGET - autoUsed)),
    known: today, // false면 오늘은 아직 Tracker를 쓰지 않아 한도 전체가 남아 있다고 본다
  };
}

const serverStates = async (env) =>
  (await env.DB.prepare("SELECT server,rank_at,rank_try_at,rank_count,rank_error FROM servers ORDER BY server").all()).results;

const playerByUid = (env, uid) => env.DB.prepare(SELECT_ROW + " WHERE p.uid=?1").bind(uid).first();

const playerByNick = (env, server, nick) =>
  env.DB
    .prepare(SELECT_ROW + " WHERE p.server=?1 AND p.nick=?2 COLLATE NOCASE ORDER BY p.nick=?2 DESC,w.rank IS NULL,w.rank LIMIT 1")
    .bind(server, nick)
    .first();

function cleanServers(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const s = Number(v);
    if (validServer(s) && !out.includes(s)) out.push(s);
  }
  return out.slice(0, MAX_LOAD_SERVERS);
}

function cleanNick(v) {
  const nick = String(v ?? "").trim();
  if (!nick || nick.length > 80) throw new AppError("닉네임을 확인해 주세요", 400);
  return nick;
}

// 아직 한 번도 수집하지 못한 서버는 요청 중에 바로 읽어 온다(Cron이 채우기 전에도 화면이 비지 않게).
async function fillMissing(env, servers, states) {
  const t = now();
  const missing = servers
    .filter((s) => {
      const st = states.find((x) => x.server === s);
      return st && st.rank_at == null && (st.rank_try_at == null || st.rank_try_at <= t - RANK_MANUAL_GAP);
    })
    .slice(0, LAZY_RANKS);
  if (!missing.length) return states;
  await Promise.all(missing.map((s) => collectRanking(env, s).catch(() => {})));
  return serverStates(env);
}

async function actionLoad(env, b) {
  const servers = cleanServers(b.servers);
  const meUid = UID.test(String(b.me ?? "")) ? String(b.me) : null;
  const states = await fillMissing(env, servers, await serverStates(env));
  let players = [];
  if (servers.length) {
    players = (
      await env.DB
        .prepare(SELECT_ROW + " WHERE p.server IN (" + servers.map(() => "?").join(",") + ") AND (w.uid IS NOT NULL OR p.hero IS NOT NULL)")
        .bind(...servers)
        .all()
    ).results;
  }
  let cron = null;
  try {
    cron = JSON.parse((await getMeta(env, "cron")) ?? "null");
  } catch {}
  return { players, me: meUid ? await playerByUid(env, meUid) : null, servers: states, cron };
}

// 내 캐릭터 등록. 공개 랭킹에 있으면 API를 쓰지 않고, 없을 때만 Tracker로 찾는다.
async function actionRegister(env, b) {
  const server = Number(b.server);
  if (!validServer(server)) throw new AppError("서버 번호를 확인해 주세요", 400);
  const nick = cleanNick(b.nick);
  await fillMissing(env, [server], await serverStates(env));
  let row = await playerByNick(env, server, nick);
  let viaTracker = false;
  if (!row || row.hero == null) {
    const { uid } = await refreshPlayer(env, row ? row.uid : server + "/" + encodeURIComponent(nick), server);
    row = await playerByUid(env, uid);
    viaTracker = true;
  }
  return { me: row, message: viaTracker ? "내 캐릭터 등록 완료 · Tracker 조회 1회 사용" : "내 캐릭터 등록 완료 · 공개 랭킹에서 확인 (API 차감 없음)" };
}

async function actionRefresh(env, b) {
  const uid = String(b.uid ?? "");
  if (!UID.test(uid)) throw new AppError("유저 ID를 확인해 주세요", 400);
  const { hero } = await refreshPlayer(env, uid, null);
  return { player: await playerByUid(env, uid), message: hero === null ? "Tracker가 영웅 총투력을 주지 않아 이전 값을 유지합니다" : "영웅 총투력 갱신 완료" };
}

// 공개 랭킹(상위 100위)에 없는 유저를 서버·닉네임으로 찾는다.
async function actionLookup(env, b) {
  const server = Number(b.server);
  if (!validServer(server)) throw new AppError("서버 번호를 확인해 주세요", 400);
  const nick = cleanNick(b.nick);
  const saved = await playerByNick(env, server, nick);
  const { uid, hero } = await refreshPlayer(env, saved ? saved.uid : server + "/" + encodeURIComponent(nick), server);
  return { player: await playerByUid(env, uid), message: hero === null ? "유저는 찾았지만 영웅 총투력이 제공되지 않았습니다" : "유저 조회 완료" };
}

async function actionRanking(env, b) {
  const server = Number(b.server);
  if (!validServer(server)) throw new AppError("서버 번호를 확인해 주세요", 400);
  const st = await env.DB.prepare("SELECT rank_try_at FROM servers WHERE server=?").bind(server).first();
  if (st?.rank_try_at && st.rank_try_at > now() - RANK_MANUAL_GAP) {
    throw new AppError("#" + server + " 서버는 방금 수집을 시도했습니다. 5분 뒤에 다시 눌러 주세요.", 429);
  }
  const n = await collectRanking(env, server);
  return { message: "#" + server + " 서버 공개 랭킹 " + n + "명 갱신 · API 차감 없음" };
}

const ACTIONS = { load: actionLoad, register: actionRegister, refresh: actionRefresh, lookup: actionLookup, ranking: actionRanking };

// ---------------------------------------------------------------- 자동 수집 (Cron, 15분마다)

async function runCron(env) {
  const report = { at: now(), ranks: [], guildsOk: 0, guildsFail: 0 };
  try {
    await init(env);
    const t = now();

    // 1) 공개 랭킹: 가장 오래된 서버부터. Tracker API와 무관하다.
    const dueServers = (
      await env.DB
        .prepare(
          "SELECT server FROM servers WHERE (rank_at IS NULL OR rank_at<=?1) AND (rank_try_at IS NULL OR rank_try_at<=?2) ORDER BY rank_at IS NOT NULL,rank_at,server LIMIT ?3",
        )
        .bind(t - RANK_INTERVAL, t - RANK_RETRY, RANKS_PER_TICK)
        .all()
    ).results;
    for (const { server } of dueServers) {
      try {
        report.ranks.push({ server, count: await collectRanking(env, server) });
      } catch (err) {
        report.ranks.push({ server, error: err.message });
      }
    }

    // 2) 전체 투력: 랭킹에 오른 인원이 많은 길드부터 하루 한 번.
    const dueGuilds = (
      await env.DB
        .prepare("SELECT server,tag,fails FROM guilds WHERE ranked>0 AND next_at<=?1 ORDER BY ranked DESC,next_at,server,tag LIMIT ?2")
        .bind(t, GUILDS_PER_TICK)
        .all()
    ).results;
    for (const g of dueGuilds) {
      try {
        await collectGuild(env, g.server, g.tag);
        await env.DB
          .prepare("UPDATE guilds SET fetched_at=?3,next_at=?4,fails=0,error=NULL WHERE server=?1 AND tag=?2")
          .bind(g.server, g.tag, now(), now() + GUILD_INTERVAL)
          .run();
        report.guildsOk++;
      } catch (err) {
        if (err instanceof AppError && err.status === 429) {
          report.note = err.message; // 오늘 몫을 다 썼다. 길드 상태는 건드리지 않고 내일 이어서 한다.
          break;
        }
        // 실패한 길드는 6시간부터 최대 7일까지 간격을 늘려 가며 다시 시도한다.
        const wait = Math.min(6 * HOUR * 2 ** Math.min(g.fails, 5), 7 * DAY);
        await env.DB
          .prepare("UPDATE guilds SET fails=fails+1,next_at=?3,error=?4 WHERE server=?1 AND tag=?2")
          .bind(g.server, g.tag, now() + wait, String(err?.message ?? err).slice(0, 200))
          .run();
        report.guildsFail++;
      }
    }

    await env.DB.prepare("DELETE FROM quota WHERE day<?").bind(new Date(Date.now() - 14 * DAY * 1000).toISOString().slice(0, 10)).run();
  } catch (err) {
    report.error = String(err?.message ?? err);
  }
  console.log("cron", JSON.stringify(report));
  try {
    await setMeta(env, "cron", JSON.stringify(report));
  } catch {}
  return report;
}

// ---------------------------------------------------------------- 요청 처리

function page() {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return new Response(HTML.replaceAll("{{NONCE}}", nonce), {
    headers: {
      ...HEAD,
      "Content-Type": "text/html; charset=UTF-8",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "GET" || request.method === "HEAD") {
      return new URL(request.url).pathname === "/" ? page() : new Response("Not Found", { status: 404, headers: HEAD });
    }
    if (request.method !== "POST") return reply({ error: "허용되지 않은 요청" }, 405);

    let b;
    try {
      b = await request.json();
    } catch {
      b = null;
    }
    if (!b || typeof b !== "object" || Array.isArray(b)) return reply({ error: "요청 형식 오류" }, 400);

    const missing = [!env.ADMIN_PASSWORD && "ADMIN_PASSWORD", !env.TRACKER_API_KEY && "TRACKER_API_KEY", !env.DB && "DB 바인딩"].filter(Boolean);
    if (missing.length) return reply({ error: "서버 설정 누락: " + missing.join(", ") }, 500);

    if (b.action === "login") {
      if (!(await checkPassword(env, b.password))) return reply({ error: "비밀번호가 맞지 않습니다" }, 401);
      return reply({ token: await issueToken(env) });
    }
    if (!(await checkToken(env, b.token))) return reply({ error: "로그인이 필요합니다" }, 401);

    const action = Object.hasOwn(ACTIONS, b.action) ? ACTIONS[b.action] : null;
    if (!action) return reply({ error: "알 수 없는 요청" }, 400);
    try {
      await init(env);
      let data, failure;
      try {
        data = await action(env, b);
      } catch (err) {
        failure = err;
      }
      // 실패해도 한도가 차감됐을 수 있으므로 잔여 횟수는 항상 함께 내려준다.
      const quota = await quotaInfo(env);
      if (!failure) return reply({ ...data, quota, now: now() });
      if (!(failure instanceof AppError)) console.error("action failed", b.action, failure);
      const status = failure instanceof AppError ? failure.status : 500;
      // 로그인한 사용자에게만 도달하는 응답이라 원인을 숨기지 않는다.
      return reply({ error: failure instanceof AppError ? failure.message : "처리 실패: " + String(failure?.message ?? failure), quota, now: now() }, status);
    } catch (err) {
      console.error("request failed", b.action, err);
      return reply({ error: "DB 처리 실패: " + String(err?.message ?? err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

// ---------------------------------------------------------------- 화면
// String.raw 안이므로 아래 스크립트에서는 백틱과 달러-중괄호 표기를 쓰지 않는다.

const HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>LAST BATTLE</title>
<style nonce="{{NONCE}}">
*{box-sizing:border-box}
body{margin:0;background:#171b22;color:#e7e9ee;font:16px/1.45 system-ui,sans-serif}
main{max-width:700px;margin:auto;padding:16px}
h1{color:#dfc18b;margin:0 0 4px;font-size:30px}
h2{font-size:19px;margin:0 0 12px}
p{margin:6px 0}
small,.muted{color:#aeb8c6}
.card{background:#242b35;border:1px solid #39414e;border-radius:14px;padding:16px;margin:14px 0}
input,select,button{font:inherit;border:1px solid #515e70;border-radius:10px;padding:12px;background:#171b22;color:#fff;min-width:0;width:100%}
button{background:#dfc18b;color:#181a20;font-weight:700;cursor:pointer}
button.ghost{background:#242b35;color:#e7e9ee}
button.mini{width:auto;flex:none;padding:6px 12px;font-size:14px}
.busy button{opacity:.55;pointer-events:none}
.field{margin:10px 0}
.field label{display:block;margin:0 0 6px;color:#aeb8c6;font-size:14px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.hint{display:block;margin-top:10px}
.chips{display:grid;grid-template-columns:repeat(auto-fill,minmax(62px,1fr));gap:6px}
.chips button{padding:10px 0;background:#171b22;color:#e7e9ee;font-weight:600}
.chips button.mine{border-color:#dfc18b}
.chips button.on{background:#dfc18b;color:#181a20;border-color:#dfc18b}
.seg{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:10px 0}
.seg button{background:#171b22;color:#e7e9ee;padding:10px 4px;font-size:14px}
.seg button.on{background:#dfc18b;color:#181a20;border-color:#dfc18b}
.line{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px}
.entry{border-top:1px solid #3b4553;border-left:3px solid transparent;padding:12px 0 12px 10px;overflow-wrap:anywhere}
.entry.strong{border-left-color:#ef9999}
.entry.weak{border-left-color:#81d7a9}
.power{font-size:18px;font-weight:700}
.up{color:#ef9999}
.down{color:#81d7a9}
.act.green{color:#81d7a9}
.act.yellow{color:#f0d66f}
.act.orange{color:#f0a25f}
.act.red{color:#ef9999}
.act.gray{color:#aeb8c6}
#msg{white-space:pre-wrap;margin:12px 0;color:#c1c9d4;min-height:1.45em}
#msg.err{color:#ef9999}
#mePower{color:#dfc18b;font-weight:700;font-size:18px}
#summary{font-weight:600;margin-top:12px}
summary{cursor:pointer;font-weight:700}
footer{margin:18px 0 30px}
[hidden]{display:none!important}
</style>
</head>
<body>
<main>
<header><h1>LAST BATTLE</h1><small>영웅 총투력 비교 · 225~256 서버</small></header>
<p id="msg" role="status"></p>

<section id="login" class="card" hidden>
<form id="auth">
<div class="field"><label for="pw">관리자 비밀번호</label><input id="pw" type="password" required autocomplete="current-password"></div>
<button type="submit">접속</button>
<small class="hint">한 번 접속하면 이 기기에서 30일 동안 유지됩니다.</small>
</form>
</section>

<div id="app" hidden>
<section class="card">
<h2>내 캐릭터</h2>
<div id="meView" hidden>
<p id="meName"></p>
<p id="mePower"></p>
<small id="meMeta"></small>
<div class="pair"><button id="meRefresh" type="button">내 투력 갱신</button><button id="meEdit" type="button" class="ghost">캐릭터 변경</button></div>
<small class="hint">내 투력 갱신은 Tracker API를 1회 사용합니다.</small>
</div>
<form id="meForm" hidden>
<div class="field"><label for="meServer">내 서버</label><select id="meServer"></select></div>
<div class="field"><label for="meNick">내 닉네임</label><input id="meNick" maxlength="80" required placeholder="게임 닉네임 그대로"></div>
<button type="submit">내 캐릭터 등록</button>
<small class="hint">처음 한 번만 등록하면 됩니다. 공개 랭킹(서버 상위 100위)에 있으면 API를 쓰지 않습니다.</small>
</form>
</section>

<section class="card">
<h2>상대 서버</h2>
<div id="chips" class="chips"></div>
<small class="hint">여러 서버를 함께 고를 수 있습니다. 저장된 데이터를 보여 주므로 API는 차감되지 않습니다.</small>
<div id="info"></div>
</section>

<section class="card">
<h2>비교</h2>
<input id="q" type="search" maxlength="80" placeholder="닉네임 또는 길드 검색" autocomplete="off">
<div id="mode" class="seg"><button type="button" data-mode="all" class="on">전체</button><button type="button" data-mode="strong">나보다 강함</button><button type="button" data-mode="weak">나보다 약함</button></div>
<select id="sort" aria-label="정렬"><option value="hero">영웅 총투력 높은 순</option><option value="near">나와 차이가 작은 순</option></select>
<p id="summary" class="muted"></p>
<div id="list"></div>
<button id="more" type="button" class="ghost" hidden>더 보기</button>
</section>

<details class="card">
<summary>랭킹에 없는 유저 조회</summary>
<form id="lookup">
<div class="field"><label for="lookServer">서버</label><select id="lookServer"></select></div>
<div class="field"><label for="lookNick">닉네임</label><input id="lookNick" maxlength="80" required></div>
<button type="submit">유저 조회</button>
<small class="hint">서버 상위 100위 밖의 유저를 Tracker에서 찾습니다. API를 1회 사용합니다.</small>
</form>
</details>

<footer>
<small id="quota"></small><br>
<small id="cron"></small>
<div class="line"><small>활동 추정은 접속 여부가 아니라 전체 투력 변동 기록 기준입니다.</small><button id="logout" type="button" class="mini ghost">로그아웃</button></div>
</footer>
</div>
</main>
<script nonce="{{NONCE}}">
(() => {
'use strict';
const $ = id => document.getElementById(id);
const MIN = 225, MAX = 256, PAGE = 150, DAY = 86400;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  raw(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
};
const okServer = s => Number.isInteger(s) && s >= MIN && s <= MAX;

let token = store.get('lbToken', '');
let me = store.get('lbMe', null);
if (!me || !/^\d{1,20}$/.test(String(me.uid)) || !okServer(me.server)) me = null;
let picked = store.get('lbServers', []);
picked = Array.isArray(picked) ? picked.filter(okServer) : [];
let rows = new Map(), meRow = null, info = {}, quota = null, cron = null;
let mode = 'all', limit = PAGE, busy = false, skew = 0;

const fmt = n => Number(n).toLocaleString('ko-KR');
const pad = n => (n < 10 ? '0' : '') + n;
const nowS = () => Math.floor(Date.now() / 1000) + skew;
function when(ts) { const d = new Date(ts * 1000); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function ago(ts) {
  const s = Math.max(0, nowS() - ts);
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + '분 전';
  if (s < DAY) return Math.floor(s / 3600) + '시간 전';
  return Math.floor(s / DAY) + '일 전';
}
function el(tag, text, cls) { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; }
function say(text, isError) { const m = $('msg'); m.textContent = text || ''; m.className = isError ? 'err' : ''; }

function showLogin() { $('login').hidden = false; $('app').hidden = true; }
function showApp() { $('login').hidden = true; $('app').hidden = false; }

async function api(action, extra) {
  let res, j = null;
  try {
    res = await fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action: action, token: token }, extra || {})) });
  } catch (e) { throw Error('서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.'); }
  try { j = await res.json(); } catch (e) {}
  if (res.status === 401 && action !== 'login') { token = ''; store.del('lbToken'); showLogin(); throw Error('로그인이 만료되었습니다. 다시 접속해 주세요.'); }
  if (j && j.quota) { quota = j.quota; renderQuota(); }
  if (j && j.now) skew = j.now - Math.floor(Date.now() / 1000);
  if (!res.ok || !j) throw Error((j && j.error) || '요청 실패 (HTTP ' + res.status + ')');
  return j;
}

// 한 번에 하나의 작업만 실행한다. fn이 돌려준 문자열을 결과 메시지로 보여 준다.
async function run(label, fn) {
  if (busy) return;
  busy = true; document.body.classList.add('busy'); say(label);
  try { say(await fn()); } catch (e) { say(e.message, true); }
  finally { busy = false; document.body.classList.remove('busy'); }
}

async function fetchServers(list) {
  for (let i = 0; i < Math.max(1, list.length); i += 8) {
    const j = await api('load', { servers: list.slice(i, i + 8), me: me ? me.uid : null });
    for (const p of j.players) rows.set(p.uid, p);
    info = {};
    for (const s of j.servers) info[s.server] = s;
    meRow = j.me || null;
    cron = j.cron || null;
  }
  render();
  const failed = picked.filter(s => info[s] && !info[s].rank_at);
  return failed.length ? '아직 랭킹을 가져오지 못한 서버: ' + failed.map(s => '#' + s).join(', ') + ' · 잠시 후 새로고침해 주세요.' : '';
}

// 전체 투력 변동 기록으로 활동성을 추정한다.
function activity(p) {
  if (!p.total_at) return ['gray', '활동 기록 없음'];
  const t = nowS();
  const first = p.first_at || p.baseline_at || p.total_at;
  const base = p.baseline_at || first;
  if (t - p.total_at > 2 * DAY) return ['gray', '전체 투력 수집 지연 · 판단 보류'];
  const idle = t - base;
  if (base > first && idle < DAY) return ['green', '최근 24시간 내 전체 투력 변동'];
  if (base <= first && p.total_at - first < 20 * 3600) return ['gray', '활동 기록 부족 (수집 시작 ' + ago(first) + ')'];
  const days = Math.max(1, Math.floor(idle / DAY));
  const label = '전체 투력 ' + days + '일 이상 미변동';
  if (idle < 3 * DAY) return ['yellow', label];
  if (idle < 7 * DAY) return ['orange', label];
  return ['red', label];
}

function sourceText(p) {
  if (!p.hero_at) return '';
  return when(p.hero_at) + ' 기준 · ' + (p.src === 'tracker' ? 'Tracker 조회' : '공개 랭킹');
}

function renderMe() {
  $('meView').hidden = !me; $('meForm').hidden = !!me;
  if (!me) return;
  const r = meRow;
  $('meName').textContent = '#' + me.server + ' ' + (r ? r.nick : me.nick) + (r && r.guild ? ' [' + r.guild + ']' : '');
  $('mePower').textContent = r && r.hero != null ? '영웅 총투력 ' + fmt(r.hero) : '영웅 총투력 미확인 · 내 투력 갱신을 눌러 주세요';
  $('meMeta').textContent = r && r.hero != null ? (r.rank ? '서버 ' + r.rank + '위 · ' : '') + sourceText(r) : '';
}

function renderChips() {
  for (const b of $('chips').children) {
    const s = Number(b.dataset.server);
    b.classList.toggle('on', picked.includes(s));
    b.classList.toggle('mine', !!me && me.server === s);
  }
}

function renderInfo() {
  const box = $('info'); box.replaceChildren();
  for (const s of picked) {
    const i = info[s] || {};
    const line = el('div', '', 'line');
    line.append(el('small', '#' + s + ' · ' + (i.rank_at
      ? '랭킹 ' + (i.rank_count || 0) + '명 · ' + when(i.rank_at) + ' 수집 (' + ago(i.rank_at) + ')'
      : '랭킹 미수집' + (i.rank_error ? ' · ' + i.rank_error : ''))));
    const b = el('button', '새로고침', 'mini ghost'); b.type = 'button';
    b.onclick = () => run('#' + s + ' 서버 공개 랭킹을 다시 읽는 중입니다.', async () => { const j = await api('ranking', { server: s }); await fetchServers([s]); return j.message; });
    line.append(b); box.append(line);
  }
}

function entry(p, my) {
  const e = el('div', '', 'entry');
  const head = el('div', '', 'line');
  head.append(el('strong', p.nick + (p.guild ? ' [' + p.guild + ']' : '')));
  head.append(el('small', '#' + p.server + (p.rank ? ' · ' + p.rank + '위' : ' · 100위 밖')));
  e.append(head);
  e.append(el('div', p.hero == null ? '영웅 총투력 미확인' : fmt(p.hero), 'power'));
  if (my && p.hero != null) {
    const d = p.hero - my, pct = (p.hero / my * 100).toFixed(1) + '%';
    if (d > 0) { e.classList.add('strong'); e.append(el('div', '▲ 나보다 +' + fmt(d) + ' · 내 투력의 ' + pct, 'up')); }
    else if (d < 0) { e.classList.add('weak'); e.append(el('div', '▼ 나보다 −' + fmt(-d) + ' · 내 투력의 ' + pct, 'down')); }
    else e.append(el('div', '나와 동일', 'muted'));
  }
  const a = activity(p);
  e.append(el('small', '● ' + a[1], 'act ' + a[0]));
  const foot = el('div', '', 'line');
  foot.append(el('small', sourceText(p)));
  const b = el('button', '갱신', 'mini ghost'); b.type = 'button';
  b.onclick = () => run(p.nick + ' 영웅 총투력을 Tracker에서 읽는 중입니다.', async () => {
    const j = await api('refresh', { uid: p.uid });
    if (j.player) rows.set(j.player.uid, j.player);
    render(); return j.message;
  });
  foot.append(b); e.append(foot);
  return e;
}

function renderList() {
  const my = meRow && meRow.hero != null ? meRow.hero : 0;
  const q = $('q').value.trim().toLowerCase();
  let list = Array.from(rows.values()).filter(p => picked.includes(p.server) && !(me && p.uid === me.uid));
  if (q) list = list.filter(p => p.nick.toLowerCase().includes(q) || (p.guild || '').toLowerCase().includes(q));
  const strong = my ? list.filter(p => p.hero != null && p.hero > my).length : 0;
  const weak = my ? list.filter(p => p.hero != null && p.hero < my).length : 0;
  if (my && mode === 'strong') list = list.filter(p => p.hero != null && p.hero > my);
  if (my && mode === 'weak') list = list.filter(p => p.hero != null && p.hero < my);
  const key = p => (p.hero == null ? -1 : p.hero);
  if (my && $('sort').value === 'near') list.sort((a, b) => Math.abs(key(a) - my) - Math.abs(key(b) - my));
  else list.sort((a, b) => key(b) - key(a));

  const out = $('list'); out.replaceChildren();
  if (!picked.length) $('summary').textContent = '위에서 상대 서버를 선택해 주세요.';
  else if (!my) $('summary').textContent = list.length + '명 · 내 캐릭터를 등록하면 투력 차이를 보여 줍니다.';
  else $('summary').textContent = '서버 ' + picked.length + '곳 · ' + list.length + '명 표시 · 나보다 강함 ' + strong + '명 · 약함 ' + weak + '명';
  for (const p of list.slice(0, limit)) out.append(entry(p, my));
  $('more').hidden = list.length <= limit;
  $('more').textContent = '더 보기 (' + Math.max(0, list.length - limit) + '명 남음)';
}

function renderQuota() {
  if (!quota) return;
  $('quota').textContent = 'Tracker API 오늘 잔여 ' + fmt(quota.remaining) + ' / ' + fmt(quota.limit) +
    ' · 수동 갱신 가능 ' + fmt(quota.manualLeft) + '회 · 자동 수집 ' + quota.autoUsed + '/' + quota.autoBudget + '회 사용 · 매일 오전 9시 초기화';
}

function renderCron() {
  $('cron').textContent = cron && cron.at
    ? '자동 수집 마지막 실행 ' + when(cron.at) + ' (' + ago(cron.at) + ')' + (cron.error ? ' · 오류: ' + cron.error : '')
    : '자동 수집 실행 기록이 아직 없습니다.';
}

function render() { renderMe(); renderChips(); renderInfo(); renderList(); renderQuota(); renderCron(); }

// ---- 초기 화면 구성과 이벤트
for (const id of ['meServer', 'lookServer']) {
  for (let s = MIN; s <= MAX; s++) { const o = el('option', '#' + s); o.value = s; $(id).append(o); }
}
for (let s = MIN; s <= MAX; s++) {
  const b = el('button', String(s)); b.type = 'button'; b.dataset.server = s;
  b.onclick = () => {
    if (busy) return;
    const i = picked.indexOf(s);
    if (i >= 0) {
      picked.splice(i, 1);
      for (const p of Array.from(rows.values())) if (p.server === s) rows.delete(p.uid);
      store.set('lbServers', picked); limit = PAGE; render(); return;
    }
    picked.push(s); picked.sort((a, b) => a - b); store.set('lbServers', picked); limit = PAGE; renderChips();
    run('#' + s + ' 서버 데이터를 불러오는 중입니다.', () => fetchServers([s]));
  };
  $('chips').append(b);
}
$('meServer').value = Number(store.raw('lbMineServer')) || 252;
$('meNick').value = store.raw('lbMineNick') || '';
$('lookServer').value = 252;

$('auth').onsubmit = e => {
  e.preventDefault();
  const password = $('pw').value; $('pw').value = '';
  run('접속 중입니다.', async () => {
    const j = await api('login', { password: password });
    token = j.token; store.set('lbToken', token); showApp();
    return fetchServers(picked);
  });
};
$('meForm').onsubmit = e => {
  e.preventDefault();
  const server = Number($('meServer').value), nick = $('meNick').value.trim();
  if (!nick) return say('내 닉네임을 입력해 주세요.', true);
  run('내 캐릭터를 찾는 중입니다.', async () => {
    const j = await api('register', { server: server, nick: nick });
    me = { uid: j.me.uid, server: j.me.server, nick: j.me.nick }; meRow = j.me; store.set('lbMe', me);
    render(); return j.message;
  });
};
$('meRefresh').onclick = () => run('내 영웅 총투력을 Tracker에서 읽는 중입니다.', async () => {
  const j = await api('refresh', { uid: me.uid });
  if (j.player) meRow = j.player;
  render(); return j.message;
});
$('meEdit').onclick = () => {
  if (busy) return;
  $('meServer').value = me.server; $('meNick').value = me.nick;
  me = null; meRow = null; store.del('lbMe'); render();
};
$('lookup').onsubmit = e => {
  e.preventDefault();
  const server = Number($('lookServer').value), nick = $('lookNick').value.trim();
  if (!nick) return;
  run(nick + ' 유저를 Tracker에서 찾는 중입니다.', async () => {
    const j = await api('lookup', { server: server, nick: nick });
    const p = j.player;
    if (!p) return j.message;
    rows.set(p.uid, p);
    if (!picked.includes(p.server)) { picked.push(p.server); picked.sort((a, b) => a - b); store.set('lbServers', picked); await fetchServers([p.server]); rows.set(p.uid, p); }
    $('q').value = p.nick; limit = PAGE; render();
    return j.message + ' · #' + p.server + ' ' + p.nick + (p.hero != null ? ' 영웅 총투력 ' + fmt(p.hero) : '');
  });
};
$('q').oninput = () => { limit = PAGE; renderList(); };
$('sort').onchange = () => { limit = PAGE; renderList(); };
for (const b of $('mode').children) {
  b.onclick = () => {
    mode = b.dataset.mode; limit = PAGE;
    for (const x of $('mode').children) x.classList.toggle('on', x === b);
    renderList();
  };
}
$('more').onclick = () => { limit += PAGE; renderList(); };
$('logout').onclick = () => { token = ''; store.del('lbToken'); say(''); showLogin(); };

if (token) { showApp(); render(); run('저장된 데이터를 불러오는 중입니다.', () => fetchServers(picked)); }
else showLogin();
})();
</script>
</body>
</html>`;
