/* passage.js — 역 안 지하도 선 모양(web/data/passage.json, docs/graph-format.md 20절)으로 그릴 조각 고르기
   - 그림만 바꾼다. 거리·시간·탐색은 graph.json 간선 그대로다(길이를 쓰지 않는다).
   - 브라우저와 Node(check_passage.js) 양쪽에서 쓴다. DOM·Leaflet 을 쓰지 않는다.
   - 조각 = {kind, pts}. kind 'under' = 지하 통로(경로의 지하 색 실선), 'xfer' = 모양을 모르는 곳(옅은 점선).
     · 출입구 간선: 지하도 선(출구 → 역)이 있으면 그 선 + 선 끝 ↔ 승강장 허브(점선). 없으면 null(원래 직선 그대로).
     · 환승 간선: 지하도 선이 있으면 허브 ↔ 선 첫 점(점선) + 선(실선) + 선 끝 ↔ 허브(점선). 없으면 두 허브 사이 점선 하나.
     · 그 밖의 간선: null. */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const GR = UG.graph;
  const GAP_M = 3;   // 선 끝과 허브가 이보다 가까우면 점선 없이 바로 잇는다(화면에서 안 보이는 길이)

  function ok(data) { return !!(data && data.format === 'passage-1' && data.exits && data.transfers); }

  // 간선 e 의 지하도 선(없으면 null). 출입구 간선은 출구 -> 허브, 환승 간선은 a 허브 -> b 허브 방향.
  function lineOf(G, data, e) {
    if (!ok(data)) return null;
    const E = G.g.edges;
    let enc = null;
    if (E.k[e] === G.codes.transfer) enc = data.transfers[String(e)];
    else if (E.k[e] === G.codes.entrance) {
      const i = entranceOf(G, e);
      if (i >= 0) enc = data.exits[String(i)];
    }
    return enc ? GR.decodePolyline(enc, data.precision) : null;
  }

  // 출입구 간선의 출입구 번호(entrances 배열 위치). 아니면 -1
  function entranceOf(G, e) {
    const E = G.g.edges;
    const i = G.entranceAt.get(E.a[e]);
    if (i != null) return i;
    const j = G.entranceAt.get(E.b[e]);
    return j != null ? j : -1;
  }

  // 간선 e 를 노드 u 쪽에서 걸을 때 그릴 조각들(위 설명). 바꿀 것이 없으면 null.
  function edgePieces(G, data, e, u) {
    const g = G.g, E = g.edges, k = E.k[e];
    const isXfer = k === G.codes.transfer, isEnt = k === G.codes.entrance;
    if (!isXfer && !isEnt) return null;
    const line = lineOf(G, data, e);
    if (!line) return isXfer ? [{ kind: 'xfer', pts: GR.edgeShape(g, e, u) }] : null;
    // 선의 시작 쪽 노드와 끝 쪽 노드(출입구 간선: 출입구 노드 -> 허브, 환승 간선: a -> b)
    let start = E.a[e], end = E.b[e];
    if (isEnt && G.entranceAt.get(start) == null) { start = E.b[e]; end = E.a[e]; }
    const pieces = [];
    const gap = function (p, q) { if (GR.haversine(p[0], p[1], q[0], q[1]) >= GAP_M) pieces.push({ kind: 'xfer', pts: [p, q] }); };
    if (isXfer) gap(GR.nodeLatLng(g, start), line[0]);   // 출입구 쪽 첫 점은 출입구 노드 자리 그대로다
    pieces.push({ kind: 'under', pts: line });
    gap(line[line.length - 1], GR.nodeLatLng(g, end));
    if (u === start) return pieces;
    // 반대 방향으로 걷는다: 조각 순서와 점 순서를 모두 뒤집는다
    return pieces.reverse().map(function (p) { return { kind: p.kind, pts: p.pts.slice().reverse() }; });
  }

  // 조각들을 한 줄로(지도 맞추기·길 안내 위치 추정 선). 이어진 점은 한 번만 넣는다.
  function joined(pieces) {
    const out = [];
    pieces.forEach(function (p) {
      p.pts.forEach(function (q, i) {
        const last = out[out.length - 1];
        if (i === 0 && last && last[0] === q[0] && last[1] === q[1]) return;
        out.push(q);
      });
    });
    return out;
  }

  UG.passage = { ok: ok, lineOf: lineOf, entranceOf: entranceOf, edgePieces: edgePieces, joined: joined, GAP_M: GAP_M };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.passage;
})(typeof globalThis !== 'undefined' ? globalThis : this);
