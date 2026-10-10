import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { createMapProxy } from "../server/map-proxy.js";
import { createApp } from "../server/app.js";

const tile = "/map-data/tiles/6/36/24.mvt";
const other = "/map-data/tiles/6/37/24.mvt";
const reply = (body = "tile", headers = {}) => new Response(body, { headers: { "Content-Type": "application/x-protobuf", ...headers } });
async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "map-proxy-"));
  const proxy = createMapProxy({ directory, origin: "https://map.example.test", ...options });
  const app = await createApp({ mapProxy: proxy });
  const server = app.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); proxy.close(); await rm(directory,{ recursive:true,force:true }); });
  return { directory, proxy, app, get: (route=tile, init) => fetch(`http://127.0.0.1:${server.address().port}${route}`,init) };
}

test("map data is served locally, persists across restarts, and never forwards visitor headers", async t => {
  const calls=[];
  const request=async (url,options) => { calls.push({url,options});return reply(); };
  const s=await setup(t,{request});
  let response=await s.get(tile,{headers:{Cookie:"private-session",Referer:"https://map.example.test/editor/private", "X-Forwarded-For":"203.0.113.50"}});
  assert.equal(response.status,200);assert.equal(await response.text(),"tile");
  assert.match(response.headers.get("cache-control"),/max-age=60[0-9]{4}/);
  assert.equal((await s.get()).status,200);assert.equal(calls.length,1);
  assert.equal(calls[0].url,"https://vector.openstreetmap.org/shortbread_v1/6/36/24.mvt");
  const headers=calls[0].options.headers;
  assert.equal(headers.Referer,"https://map.example.test/");
  assert.match(headers["User-Agent"],/github.com\/charlieboardman\/greece-dance\/issues/);
  assert.equal(headers.Cookie,undefined);assert.equal(headers["X-Forwarded-For"],undefined);
  assert.equal(calls[0].options.redirect,"error");
  s.proxy.close();
  const restarted=createMapProxy({directory:s.directory, request:()=>{throw new Error("Must hit disk cache");}});
  t.after(()=>restarted.close());
  let body;
  await restarted.serve({path:tile.replace('/map-data','')},{set(){return this;},type(){return this;},send(value){body=value;return this;}});
  assert.equal(body.toString(),"tile");
});

test("expired cached tiles are conditionally revalidated, retaining their cache lifetime on 304", async t => {
  let clock=1000000,calls=0;
  const s=await setup(t,{now:()=>clock,request:async (_url,options)=>{
    calls++;
    if(calls===1)return reply("tile",{"Cache-Control":"public, max-age=10",ETag:'"a"'});
    assert.equal(options.headers["If-None-Match"],'"a"');return new Response(null,{status:304});
  }});
  await s.get();clock+=11000;
  const response=await s.get();assert.equal(await response.text(),"tile");assert.equal(calls,2);
  assert.match(response.headers.get("cache-control"),/max-age=10$/);
  clock+=9000;await s.get();assert.equal(calls,2);
});

test("simultaneous requests coalesce and upstream concurrency is bounded",async t=>{
  let unblock;const gate=new Promise(r=>unblock=r);let calls=0;
  const s=await setup(t,{maxConcurrent:1,maxPending:1,request:async()=>{calls++;await gate;return reply();}});
  const first=s.get(),second=s.get();
  while(!calls)await new Promise(r=>setTimeout(r,5));
  assert.equal((await s.get(other)).status,503);
  unblock();assert.equal((await first).status,200);assert.equal((await second).status,200);assert.equal(calls,1);
});

test("fresh cache entries are not evicted to make repeated upstream downloads",async t=>{
  let clock=1000000;
  const s=await setup(t,{maxBytes:4,now:()=>clock,request:async()=>reply("tile",{"Cache-Control":"max-age=10"})});
  assert.equal((await s.get()).status,200);
  assert.equal((await s.get(other)).status,503);
  assert.equal((await s.get()).status,200);
  clock+=11000;
  assert.equal((await s.get(other)).status,200);
});

test("no-store responses are never retained and failed upstream responses are not cached",async t=>{
  let calls=0;
  const s=await setup(t,{request:async()=>{calls++;return calls===1?new Response("bad",{status:404}):reply("tile",{"Cache-Control":"no-store"});}});
  assert.equal((await s.get()).status,404);
  assert.equal((await s.get()).headers.get("cache-control"),"no-store");
  assert.equal((await s.get()).status,200);assert.equal(calls,3);
});

test("oversized or HTML upstream responses are rejected without caching",async t=>{
  let calls=0;
  const s=await setup(t,{maxResponseBytes:4,request:async()=>{calls++;return calls===1?reply("oversized"):new Response("<html>",{headers:{"Content-Type":"text/html"}});}});
  assert.equal((await s.get()).status,502);assert.equal((await s.get()).status,502);assert.equal(calls,2);
});

test("rate-limited upstreams get a cooldown without passing upstream bodies to visitors",async t=>{
  let calls=0,clock=1000000;
  const s=await setup(t,{now:()=>clock,request:async()=>{calls++;return calls===1?new Response("private upstream message",{status:429,headers:{"Retry-After":"120"}}):reply();}});
  const response=await s.get();assert.equal(response.status,502);assert.doesNotMatch(await response.text(),/private upstream/);
  assert.equal((await s.get(other)).status,503);assert.equal(calls,1);
  clock+=121000;assert.equal((await s.get(other)).status,200);assert.equal(calls,2);
});

test("only valid in-coverage tile coordinates and the configured glyph font are fetched",async t=>{
  let calls=0;const s=await setup(t,{request:async()=>{calls++;return reply();}});
  for(const url of ['/tiles/15/1/1.mvt','/tiles/6/64/24.mvt','/tiles/6/0/24.mvt','/tiles/NaN/2/3.mvt','/glyphs/other/0-255.pbf','/glyphs/noto_sans_regular/1-256.pbf','/glyphs/noto_sans_regular/65536-65791.pbf','/https://example.com']) {
    assert.equal((await s.get('/map-data'+url)).status,404,url);
  }
  assert.equal(calls,0);
  assert.equal((await s.get('/map-data/glyphs/noto_sans_regular/768-1023.pbf')).status,200);
  assert.equal((await s.get(tile,{method:'POST'})).status,405);
  const csp=(await s.get('/')).headers.get('content-security-policy');
  assert.match(csp,/connect-src 'self';/);assert.match(csp,/font-src 'self';/);
});

test("ordinary browser bursts wait for an upstream slot rather than failing",async t=>{
  let release; const gate=new Promise(r=>release=r);let calls=0,active=0,peak=0;
  const s=await setup(t,{maxConcurrent:1,request:async()=>{
    calls++;active++;peak=Math.max(peak,active);
    if(calls===1)await gate;
    active--;return reply();
  }});
  const first=s.get(),second=s.get(other);
  while(!calls)await new Promise(r=>setTimeout(r,5));
  release();assert.equal((await first).status,200);assert.equal((await second).status,200);
  assert.equal(calls,2);assert.equal(peak,1);
});
