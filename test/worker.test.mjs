// 실행: node --test test/
// D1은 node:sqlite로, 외부 사이트(LastAsylum.gg, Tracker API)는 가짜 fetch로 대신한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const PASSWORD = "correct horse";
const START = Date.UTC(2026, 10, 28, 3, 0, 0);
const HOUR = 3600_000;
const realNow = Date.now;
let clock = START;
Date.now = () => clock;
const advance = (ms) => (clock += ms);

// ---- D1 대역
function d1() {
  const db = new DatabaseSync(":memory:");
  const exec = (sql, args) => {
    for (const a of args) if (a === undefined) throw new Error("D1_TYPE_ERROR: undefined bind");
    return db.prepare(sql).all(...args);
  };
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: exec(sql, args) }),
    run: async () => ({ results: exec(sql, args) }),
    first: async () => exec(sql, args)[0] ?? null,
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      db.exec("BEGIN");
      try {
        const out = list.map((s) => ({ results: exec(s.sql, s.args) }));
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

// ---- 가짜 외부 세계
function world() {
  const w = {
    rankings: new Map(), // server -> [{uid,nick,guild,hero}]
    players: new Map(), // uid -> {uid,nick_name,kid,alliance_abbr,power,heroes}
    guilds: new Map(), // "server/tag" -> [{uid,name,power}]
    quota: { limit: 1000, remaining: 1000 },
    calls: { ranking: 0, tracker: 0 },
    rankingStatus: 200,
    age: 0,
  };
  const page = (rows) =>
    '<html><body><table class="board"><thead><tr><th class="num">#</th><th>Player</th><th class="tagcol">Tag</th><th class="num">Total Hero Might</th></tr></thead><tbody>' +
    rows
      .map(
        (r, i) =>
          `<tr><td class="num muted">${i + 1}</td><td class="name"> <a href="/en/leaderboard/player/${r.uid}">${r.nick}</a></td><td class="muted tagcol">${r.guild ? "[" + r.guild + "]" : ""}</td><td class="num strong">${r.hero.toLocaleString("en-US")}</td></tr>`,
      )
      .join("") +
    "</tbody></table><script>self.__next_f.push([1,\"<tr><td>junk</td></tr>\"])</script></body></html>";
  const json = (status, body) => {
    const used = w.quota.limit - w.quota.remaining;
    return new Response(JSON.stringify({ ...body, quota: { ...w.quota, used } }), {
      status,
      headers: { "Content-Type": "application/json", "X-RateLimit-Limit": String(w.quota.limit), "X-RateLimit-Remaining": String(w.quota.remaining) },
    });
  };
  w.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "lastasylum.gg") {
      w.calls.ranking++;
      const server = Number(url.pathname.match(/servers\/(\d+)\/heroes/)[1]);
      if (w.rankingStatus !== 200) return new Response("blocked", { status: w.rankingStatus });
      return new Response(page(w.rankings.get(server) ?? []), { status: 200 });
    }
    assert.equal(url.hostname, "api.lastasylumtracker.com");
    assert.equal(init.headers.Authorization, "Bearer lap_test");
    w.calls.tracker++;
    if (w.quota.remaining <= 0) return json(429, { ok: false });
    w.quota.remaining--;
    const parts = url.pathname.split("/").slice(2).map(decodeURIComponent); // ["players", ...] | ["alliances", server, tag]
    if (parts[0] === "players") {
      const p =
        parts.length === 2
          ? w.players.get(parts[1])
          : [...w.players.values()].find((x) => x.kid === Number(parts[1]) && x.nick_name === parts[2]);
      if (!p) return json(404, { ok: false });
      const { heroes, ...rest } = p;
      return json(200, { ok: true, ...rest, ranks: { heroes: { score: heroes, rank: 1 } }, age_seconds: w.age, cached: w.age > 0 });
    }
    const members = w.guilds.get(parts[1] + "/" + parts[2]);
    if (!members) return json(404, { ok: false });
    return json(200, { ok: true, alliance: { abbr: parts[2], members }, age_seconds: w.age });
  };
  return w;
}

function seedServer(w, server, { guildSize = 25 } = {}) {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    const uid = String(server * 1_000_000 + i);
    const guild = i < 96 ? "G" + Math.floor(i / guildSize) : "";
    rows.push({ uid, nick: `P${server}_${i}`, guild, hero: 100_000_000 - i * 500_000 });
    w.players.set(uid, { uid: Number(uid), nick_name: `P${server}_${i}`, kid: server, alliance_abbr: guild, power: 200_000_000 - i * 1000, heroes: 100_000_000 - i * 500_000 });
    if (guild) {
      const key = server + "/" + guild;
      if (!w.guilds.has(key)) w.guilds.set(key, []);
      w.guilds.get(key).push({ uid: Number(uid), name: `P${server}_${i}`, power: 200_000_000 - i * 1000 });
    }
  }
  w.rankings.set(server, rows);
}

let n = 0;
async function setup({ db } = {}) {
  clock = START;
  const w = world();
  globalThis.fetch = w.fetch;
  const worker = (await import("../worker.js?fresh=" + ++n)).default; // 모듈 상태(schemaReady)를 테스트마다 새로
  const env = { DB: db ?? d1(), ADMIN_PASSWORD: PASSWORD, TRACKER_API_KEY: "lap_test" };
  const post = async (body) => {
    const res = await worker.fetch(new Request("https://site.test/", { method: "POST", body: JSON.stringify(body) }), env);
    return { status: res.status, body: await res.json() };
  };
  let token;
  const call = async (action, extra = {}) => {
    token ??= (await post({ action: "login", password: PASSWORD })).body.token;
    return post({ action, token, ...extra });
  };
  const cron = async () => {
    const pending = [];
    await worker.scheduled({ scheduledTime: clock }, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    return JSON.parse(env.DB.raw.prepare("SELECT v FROM meta WHERE k='cron'").get().v);
  };
  const sql = (q, ...a) => env.DB.raw.prepare(q).all(...a);
  return { w, worker, env, post, call, cron, sql };
}

test("화면: GET /은 CSP nonce가 들어간 HTML, 그 외 경로는 404", async () => {
  const { worker, env } = await setup();
  const res = await worker.fetch(new Request("https://site.test/"), env);
  const html = await res.text();
  const nonce = res.headers.get("Content-Security-Policy").match(/script-src 'nonce-([^']+)'/)[1];
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.ok(!html.includes("{{NONCE}}"));
  assert.ok(!html.includes("lap_test") && !html.includes(PASSWORD));
  assert.equal((await worker.fetch(new Request("https://site.test/x"), env)).status, 404);
});

test("인증: 비밀번호가 틀리거나 토큰이 없으면 401, 토큰은 만료·위조를 거른다", async () => {
  const { post } = await setup();
  assert.equal((await post({ action: "login", password: "nope" })).status, 401);
  assert.equal((await post({ action: "load", servers: [252] })).status, 401);
  assert.equal((await post({ action: "load", password: PASSWORD })).status, 401); // 예전 방식(비밀번호 동봉)은 더 이상 통하지 않는다
  const { token } = (await post({ action: "login", password: PASSWORD })).body;
  assert.equal((await post({ action: "load", token })).status, 200);
  const [exp, sig] = token.split(".");
  assert.equal((await post({ action: "load", token: Number(exp) + 1 + "." + sig })).status, 401);
  advance(31 * 24 * HOUR);
  assert.equal((await post({ action: "load", token })).status, 401);
});

test("서버 선택만으로 공개 랭킹 100명이 채워지고 Tracker는 차감되지 않는다", async () => {
  const { w, call } = await setup();
  seedServer(w, 247);
  const r = await call("load", { servers: [247] });
  assert.equal(r.status, 200);
  assert.equal(r.body.players.length, 100);
  const top = r.body.players.find((p) => p.rank === 1);
  assert.deepEqual(
    { uid: top.uid, nick: top.nick, guild: top.guild, hero: top.hero, src: top.src },
    { uid: "247000000", nick: "P247_0", guild: "G0", hero: 100_000_000, src: "rank" },
  );
  assert.equal(r.body.servers.find((s) => s.server === 247).rank_count, 100);
  assert.equal(w.calls.tracker, 0);
  assert.equal(r.body.quota.remaining, 1000);
  // 다시 불러와도 원본 사이트를 또 읽지 않는다(저장 데이터 재사용).
  await call("load", { servers: [247] });
  assert.equal(w.calls.ranking, 1);
});

test("원본 랭킹이 막히면 오류를 기록하고 화면 요청은 실패하지 않는다", async () => {
  const { w, call } = await setup();
  seedServer(w, 230);
  w.rankingStatus = 403;
  const r = await call("load", { servers: [230] });
  assert.equal(r.status, 200);
  assert.equal(r.body.players.length, 0);
  assert.match(r.body.servers.find((s) => s.server === 230).rank_error, /HTTP 403/);
  const manual = await call("ranking", { server: 230 });
  assert.equal(manual.status, 429); // 방금 시도했으므로 5분 대기
});

test("내 캐릭터: 랭킹에 있으면 API 0회, 없으면 Tracker 1회", async () => {
  const { w, call } = await setup();
  seedServer(w, 252);
  const a = await call("register", { server: 252, nick: "p252_7" }); // 대소문자 달라도 찾는다
  assert.equal(a.status, 200);
  assert.equal(a.body.me.uid, "252000007");
  assert.equal(a.body.me.hero, 96_500_000);
  assert.equal(w.calls.tracker, 0);

  w.players.set("999", { uid: 999, nick_name: "달콩쓰", kid: 252, alliance_abbr: "요즘사람", power: 150_000_000, heroes: 61_000_000 });
  const b = await call("register", { server: 252, nick: "달콩쓰" });
  assert.equal(b.status, 200);
  assert.deepEqual({ uid: b.body.me.uid, hero: b.body.me.hero, guild: b.body.me.guild, src: b.body.me.src }, { uid: "999", hero: 61_000_000, guild: "요즘사람", src: "tracker" });
  assert.equal(w.calls.tracker, 1);
  assert.equal(b.body.quota.remaining, 999);

  const c = await call("register", { server: 252, nick: "없는사람" });
  assert.equal(c.status, 404);
  assert.match(c.body.error, /찾지 못했습니다/);
  assert.equal(c.body.quota.remaining, 998); // 실패한 조회도 차감되며 화면에 반영된다

  const me = await call("load", { servers: [], me: "999" });
  assert.equal(me.body.me.hero, 61_000_000);
  assert.equal(me.body.players.length, 0);
});

test("영웅 총투력은 Tracker와 공개 랭킹 중 더 최근에 읽은 값을 쓴다", async () => {
  const { w, call, cron, sql } = await setup();
  seedServer(w, 247);
  await call("load", { servers: [247] });
  advance(HOUR);
  w.players.get("247000003").heroes = 123_456_789;
  const r = await call("refresh", { uid: "247000003" });
  assert.deepEqual({ hero: r.body.player.hero, src: r.body.player.src, rank: r.body.player.rank }, { hero: 123_456_789, src: "tracker", rank: 4 });

  // 12시간 뒤 랭킹이 다시 수집되면 그 값이 더 최신이다.
  advance(12 * HOUR);
  w.rankings.get(247)[3].hero = 98_600_000;
  sql("UPDATE servers SET rank_at=?,rank_try_at=? WHERE server!=247", clock / 1000, clock / 1000); // 다른 서버는 방금 수집한 것으로 둔다
  const report = await cron();
  assert.deepEqual(report.ranks, [{ server: 247, count: 100 }]);
  const again = (await call("load", { servers: [247] })).body.players.find((p) => p.uid === "247000003");
  assert.deepEqual({ hero: again.hero, src: again.src }, { hero: 98_600_000, src: "rank" });
});

test("Tracker가 캐시본을 줘도 버리지 않고 관측 시각만 과거로 기록한다", async () => {
  const { w, call } = await setup();
  seedServer(w, 247);
  await call("load", { servers: [247] });
  advance(HOUR);
  w.age = 600;
  const r = await call("refresh", { uid: "247000001" });
  assert.equal(r.status, 200);
  assert.equal(r.body.player.hero_at, Math.floor(clock / 1000) - 600);
});

test("상위 100위 밖으로 밀려난 유저는 순위표에서 빠진다", async () => {
  const { w, call, cron, sql } = await setup();
  seedServer(w, 240);
  await call("load", { servers: [240] });
  advance(13 * HOUR);
  const out = w.rankings.get(240).pop();
  w.rankings.get(240).unshift({ uid: "777", nick: "신규", guild: "G0", hero: 200_000_000 });
  sql("UPDATE servers SET rank_at=?,rank_try_at=? WHERE server!=240", clock / 1000, clock / 1000);
  await cron();
  const players = (await call("load", { servers: [240] })).body.players;
  assert.equal(players.length, 100);
  assert.equal(players.find((p) => p.rank === 1).nick, "신규");
  assert.ok(!players.some((p) => p.uid === out.uid));
  assert.equal(new Set(players.map((p) => p.rank)).size, 100);
});

test("자동 수집: 틱마다 랭킹 1개 서버 + 길드 4곳, 전체 투력 변동을 기록한다", async () => {
  const { w, call, cron, sql } = await setup();
  seedServer(w, 225);
  const first = await cron();
  assert.deepEqual(first.ranks, [{ server: 225, count: 100 }]);
  assert.equal(first.guildsOk, 4); // G0~G3 (각 25·25·25·21명)
  assert.equal(w.calls.tracker, 4);
  const t0 = Math.floor(clock / 1000);
  let row = sql("SELECT total,total_at,baseline_at,first_at FROM players WHERE uid='225000000'")[0];
  assert.deepEqual({ ...row }, { total: 200_000_000, total_at: t0, baseline_at: t0, first_at: t0 });
  assert.equal(sql("SELECT COUNT(*) AS n FROM players WHERE total IS NULL")[0].n, 4); // 길드 없는 4명은 기록 없음

  // 23시간 안에는 같은 길드를 다시 읽지 않는다.
  advance(HOUR);
  sql("UPDATE servers SET rank_at=?,rank_try_at=?", t0, t0);
  assert.equal((await cron()).guildsOk, 0);
  assert.equal(w.calls.tracker, 4);

  // 하루 뒤: 한 명만 투력이 변했다.
  advance(23 * HOUR);
  w.guilds.get("225/G0")[0].power = 200_500_000;
  const t1 = Math.floor(clock / 1000);
  assert.equal((await cron()).guildsOk, 4);
  row = sql("SELECT total,total_at,baseline_at,first_at FROM players WHERE uid='225000000'")[0];
  assert.deepEqual({ ...row }, { total: 200_500_000, total_at: t1, baseline_at: t1, first_at: t0 }); // 변동 관측
  row = sql("SELECT total_at,baseline_at,first_at FROM players WHERE uid='225000001'")[0];
  assert.deepEqual({ ...row }, { total_at: t1, baseline_at: t0, first_at: t0 }); // 미변동: 기준 시각 유지

  const loaded = (await call("load", { servers: [225] })).body;
  assert.equal(loaded.cron.guildsOk, 4);
  assert.equal(loaded.quota.autoUsed, 4); // UTC 날짜가 바뀌어 오늘 사용분만 센다
});

test("자동 수집: 없는 길드는 간격을 늘려 재시도하고 다른 길드 수집을 막지 않는다", async () => {
  const { w, cron, sql } = await setup();
  seedServer(w, 225);
  w.guilds.delete("225/G0");
  const r = await cron();
  assert.deepEqual({ ok: r.guildsOk, fail: r.guildsFail }, { ok: 3, fail: 1 });
  const g = sql("SELECT fails,next_at,error FROM guilds WHERE tag='G0'")[0];
  assert.equal(g.fails, 1);
  assert.equal(g.next_at, Math.floor(clock / 1000) + 6 * 3600);
  assert.match(g.error, /찾지 못했습니다/);
});

test("하루 한도: 자동 수집은 320회에서 멈추고, 수동 조회는 자동 몫과 예비를 침범하지 않는다", async () => {
  const { w, call, cron, sql } = await setup();
  seedServer(w, 225);
  await call("load", { servers: [225] });
  const today = new Date(clock).toISOString().slice(0, 10);

  // 자동 수집 몫을 거의 다 쓴 상태
  sql("INSERT INTO quota(day,lim,remaining,auto_used,manual_used) VALUES(?,1000,682,318,0)", today);
  w.quota.remaining = 682;
  const r = await cron();
  assert.equal(r.guildsOk, 2);
  assert.match(r.note, /자동 수집 한도/);
  assert.equal(sql("SELECT auto_used FROM quota")[0].auto_used, 320);

  // 수동 조회는 예비 50회를 남기고 멈춘다. 동시에 눌러도 넘지 않는다.
  sql("UPDATE quota SET remaining=53");
  w.quota.remaining = 53;
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call("refresh", { uid: "22500000" + i })));
  assert.equal(results.filter((x) => x.status === 200).length, 3);
  assert.equal(results.filter((x) => x.status === 429).length, 5);
  assert.equal(w.quota.remaining, 50);
  assert.equal((await call("load", {})).body.quota.manualLeft, 0);

  // 자동 수집이 아직 안 돈 날에는 그 몫(320)까지 보호한다.
  sql("UPDATE quota SET remaining=370,auto_used=0");
  w.quota.remaining = 370;
  assert.equal((await call("refresh", { uid: "225000000" })).status, 429);
  assert.equal(w.quota.remaining, 370);

  // UTC 날짜가 바뀌면 다시 전체 한도에서 시작한다.
  advance(24 * HOUR);
  w.quota.remaining = 1000;
  assert.equal((await call("refresh", { uid: "225000000" })).body.quota.remaining, 999);
});

test("기존 v4 DB(first_at 없음)를 그대로 이어 쓴다", async () => {
  const db = d1();
  db.raw.exec(`
    CREATE TABLE players(uid TEXT PRIMARY KEY,server INTEGER NOT NULL,nick TEXT NOT NULL,guild TEXT NOT NULL DEFAULT '',total INTEGER,hero INTEGER,total_at INTEGER,baseline_at INTEGER,hero_at INTEGER);
    CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
    CREATE TABLE tracked(server INTEGER NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(server,tag));
    CREATE TABLE wiki_ranks(uid TEXT PRIMARY KEY,server INTEGER NOT NULL,hero INTEGER NOT NULL,rank INTEGER NOT NULL,read_at INTEGER NOT NULL);
    INSERT INTO meta VALUES('seed_v3','1'),('day','2026-11-27'),('remaining','998');
    INSERT INTO tracked VALUES(252,'요즘사람');
    INSERT INTO players VALUES('251125719292',252,'달콩쓰','요즘사람',150000000,70000000,1795000000,1795000000,1795000000);
  `);
  const { call, sql } = await setup({ db });
  const r = await call("register", { server: 252, nick: "달콩쓰" });
  assert.equal(r.status, 200);
  assert.equal(r.body.me.hero, 70_000_000);
  assert.ok(sql("PRAGMA table_info(players)").some((c) => c.name === "first_at"));
  assert.equal(sql("SELECT COUNT(*) AS n FROM tracked")[0].n, 1); // 예전 테이블은 건드리지 않는다
  assert.equal(sql("SELECT COUNT(*) AS n FROM servers")[0].n, 32);
});

test.after(() => {
  Date.now = realNow;
});
