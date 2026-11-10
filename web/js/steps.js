/* steps.js — 찾은 경로를 길 안내 단계로 바꾸기 (scripts/route.py 의 describe·build_steps 를 1:1 로 옮김)
   - 'ride'(노선 하나를 따라 걷기), 'transfer'(환승 통로), 'warning'(지상 노출 경고) 세 가지 단계.
   - 규칙 설명: docs/graph-format.md 11절.
   - 반올림은 파이썬 round() 와 같게(0.5 는 짝수 쪽) 해서 Python 결과와 숫자가 똑같이 나오게 한다.
   - 화면용으로 덧붙인 값은 밑줄로 시작한다(_idx = 그 단계가 덮는 경로 안 간선 위치). */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  const WALK_KMH = 3.5;
  const OTHER = -1;   // 도시철도·광역전철 노선이 없는 선로(경부선, 기지선 등)

  // 파이썬 round(x): 정확히 .5 이면 짝수 쪽으로
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }

  function isExposed(G, ei) { return G.weight[ei] !== G.g.weights.under; }

  /* ---------- 요약: route.py describe() 의 거리·노출·시간 ---------- */
  function describe(G, startSi, path, speedKmh) {
    const speed = speedKmh || WALK_KMH, E = G.g.edges;
    let total = 0, exposed = 0;
    path.forEach(function (p) {
      total += E.len[p.e];
      if (isExposed(G, p.e)) exposed += E.len[p.e];
    });
    return {
      edges: path.map(function (p) { return p.e; }), total_m: pyRound(total), exposed_m: pyRound(exposed),
      speed_kmh: speed, est_minutes: pyRound(total / (speed * 1000 / 60)),
      steps: buildSteps(G, startSi, path, speed)
    };
  }

  /* ---------- 1) 타기·환승 부분으로 나누기 ---------- */
  function splitParts(G, path) {
    const kinds = G.g.edges.k, transfer = G.codes.transfer;
    const parts = [];
    path.forEach(function (p, i) {
      const kind = kinds[p.e] === transfer ? 'transfer' : 'ride';
      if (kind === 'transfer' || !parts.length || parts[parts.length - 1].kind !== 'ride') parts.push({ kind: kind, idx: [] });
      parts[parts.length - 1].idx.push(i);
    });
    return parts;
  }

  /* ---------- 2) 간선마다 노선 고르기 ----------
     지금 노선이 다음 간선에도 있으면 그대로, 없으면 그 자리에서 가장 길게(m) 이어지는 노선으로 바꾼다.
     빈 묶음(승강장 간선, 이름 없는 선로)은 앞 노선을 이어 가고, 맨 앞의 빈 묶음은 첫 노선에 붙인다. */
  function pickLines(sets, lens) {
    const out = [];
    let cur = null;
    for (let j = 0; j < sets.length; j++) {
      if (sets[j].length && sets[j].indexOf(cur) < 0) {
        let best = null, bestRun = -1;
        for (const line of sets[j]) {
          let run = 0, k = j;
          while (k < sets.length && (!sets[k].length || sets[k].indexOf(line) >= 0)) { run += lens[k]; k++; }
          if (run > bestRun) { best = line; bestRun = run; }
        }
        cur = best;
      }
      out.push(cur);
    }
    let first = null;
    for (const x of out) if (x !== null) { first = x; break; }
    return out.map(function (x) { return x === null ? first : x; });
  }

  // 1) 도시철도·광역전철 노선만 보고 고른다. 2) 앞뒤가 같은 노선인 OTHER 구간은 그 노선으로 메운다.
  // 3) 남은 OTHER 구간은 선로 이름에서 온 노선(예: 경부고속선)으로 고른다.
  function assignLines(G, path, idx) {
    const E = G.g.edges, T = G.g.tables;
    const sets = idx.map(function (i) { return T.line_sets[E.ls[path[i].e]]; });
    const lens = idx.map(function (i) { return E.len[path[i].e]; });
    const metro = sets.map(function (s) {
      const m = s.filter(function (l) { return T.line_metro[l]; });
      return m.length ? m : (s.length ? [OTHER] : []);
    });
    const out = pickLines(metro, lens);
    let j = 0;
    while (j < out.length) {
      if (out[j] !== OTHER) { j++; continue; }
      let k = j;
      while (k < out.length && out[k] === OTHER) k++;
      const before = j > 0 ? out[j - 1] : null, after = k < out.length ? out[k] : null;
      const fill = (before !== null && before === after) ? new Array(k - j).fill(before) : pickLines(sets.slice(j, k), lens.slice(j, k));
      for (let x = j; x < k; x++) out[x] = fill[x - j];
      j = k;
    }
    return out;
  }

  /* ---------- 종착역 방면 ----------
     노선 relation 정차 순서에서 '출발역 바로 다음이 다음 역'이고 그 뒤에 도착역이 있는 것을 모두 찾아,
     방면이 하나로 정해질 때만 돌려준다(여러 방면이 섞이면 null). 순환선은 한 바퀴 더 이어 붙여 찾는다. */
  function terminalDirection(G, line, seq) {
    if (line === null || seq.length < 2) return null;
    const a = seq[0], b = seq[1], z = seq[seq.length - 1];
    const dirs = [];
    (G.g.line_routes || []).forEach(function (r) {
      if (r.l !== line) return;
      const st = r.loop ? r.st.concat(r.st.slice(1)) : r.st;
      for (let i = 0; i < st.length - 1; i++) {
        if (st[i] === a && st[i + 1] === b && st.indexOf(z, i + 1) >= 0) {
          if (dirs.indexOf(r.dir) < 0) dirs.push(r.dir);
          break;
        }
      }
    });
    return dirs.length === 1 ? dirs[0] : null;
  }

  /* ---------- 타기 단계 ---------- */
  function rideStep(G, path, idx, line, fromSi, mPerMin) {
    const E = G.g.edges, T = G.g.tables, S = G.g.stations;
    const seq = [[fromSi, 0]];          // 지난 역: [역 번호, 단계 출발부터 거리 m]
    const parts = [];                   // 선 구간: 선 이름이 바뀔 때마다 새 구간
    let lead = 0, dist = 0, exposed = 0, tracks = 0;
    idx.forEach(function (i) {
      const ei = path[i].e, v = path[i].v, length = E.len[ei];
      dist += length;
      if (isExposed(G, ei)) exposed += length;
      if (E.k[ei] === G.codes.track) tracks += length;
      const tn = T.track_names[E.tn[ei]];
      if (tn && (!parts.length || parts[parts.length - 1].name !== tn)) {
        parts.push({ name: tn, from_station: S[seq[seq.length - 1][0]].name, to_station: '', distance_m: 0 });
      }
      if (parts.length) parts[parts.length - 1].distance_m += length;
      else lead += length;              // 첫 선 이름 앞의 승강장·이름 없는 간선은 첫 구간에 넣는다
      const si = G.nodeStation[v];
      if (si >= 0 && si !== seq[seq.length - 1][0]) seq.push([si, dist]);
    });
    if (parts.length) parts[0].distance_m += lead;
    parts.forEach(function (p, n) {
      p.to_station = n + 1 < parts.length ? parts[n + 1].from_station : S[seq[seq.length - 1][0]].name;
      p.distance_m = pyRound(p.distance_m);
    });
    const trackNames = [];
    parts.forEach(function (p) { if (trackNames.indexOf(p.name) < 0) trackNames.push(p.name); });
    const full = line !== null ? T.lines[line] : '', short = line !== null ? T.line_short[line] : '';
    const shown = trackNames.filter(function (n) { return n !== full && n !== short; });  // 노선 이름과 같은 선 이름은 다시 쓰지 않는다
    const label = (short ? [short] : []).concat(shown.length ? [shown.join('·')] : []).join(' · ') || '이름 없는 선로';
    const step = {
      type: 'ride', line: short, line_full: full, label: label, track_names: trackNames, track_parts: parts,
      from_station: S[fromSi].name, to_station: S[seq[seq.length - 1][0]].name,
      direction: seq.length > 1 ? S[seq[1][0]].name + ' 방면' : '',
      passing: seq.slice(1, -1).map(function (x) { return { station: S[x[0]].name, at_m: pyRound(x[1]) }; }),
      distance_m: pyRound(dist), est_minutes: pyRound(dist / mPerMin), exposure_m: pyRound(exposed)
    };
    const term = terminalDirection(G, line, seq.map(function (x) { return x[0]; }));
    if (term) step.terminal_direction = term;
    step._idx = idx;
    step._tracks_m = tracks;            // 선로 길이(0 이면 역 안에서만 움직이는 단계)
    step._seq = seq;                    // 지난 역 번호와 거리(지도 확대용)
    return { step: step, last: seq[seq.length - 1][0] };
  }

  /* ---------- 환승 단계 ---------- */
  function transferStep(G, path, i, mPerMin) {
    const E = G.g.edges, T = G.g.tables;
    const p = path[i];
    return {
      type: 'transfer', station: G.g.stations[G.nodeStation[p.v]].name,
      from_line: (G.hubShort.get(p.u) || []).join('/'), to_line: (G.hubShort.get(p.v) || []).join('/'),
      distance_m: pyRound(E.len[p.e]), est_minutes: pyRound(E.len[p.e] / mPerMin),
      source: T.sources[E.src[p.e]], underground: !isExposed(G, p.e), _idx: [i]
    };
  }

  /* ---------- 지상 노출 경고 ----------
     지하에서 교량·지상으로 나가는 곳마다 하나(출발부터 지상이면 출발역에서 하나).
     at = 직전에 지난 역(after_m = 그 역에서 지난 거리), exposure_m = 다시 지하로 들어갈 때까지(또는 도착까지)의 노출 거리 */
  function exposureWarnings(G, startSi, path, edgeStep) {
    const E = G.g.edges, T = G.g.tables, N = G.g.nodes, S = G.g.stations;
    const out = [];
    let cur = null, lastSi = startSi, since = 0;
    path.forEach(function (p, i) {
      const length = E.len[p.e];
      if (isExposed(G, p.e)) {
        if (cur === null) {
          cur = { type: 'warning', step: edgeStep[i], at: S[lastSi].name, after_m: pyRound(since),
            portal: (N.f[p.u] & 1) === 1, lat: N.lat[p.u] / 1e5, lon: N.lon[p.u] / 1e5,
            exposure_m: 0, structures: {}, ends_underground: false, _idx: [] };
          out.push(cur);
        }
        cur.exposure_m += length;
        const struct = T.structs[E.s[p.e]];
        cur.structures[struct] = (cur.structures[struct] || 0) + length;
        cur._idx.push(i);
      } else if (cur !== null) {
        cur.ends_underground = true;
        cur = null;
      }
      const si = G.nodeStation[p.v];
      if (si >= 0) { lastSi = si; since = 0; } else since += length;
    });
    out.forEach(function (w) {
      let best = null;
      Object.keys(w.structures).forEach(function (s) { if (best === null || w.structures[s] > w.structures[best]) best = s; });
      w.structure = best;   // 가장 긴 구조
      Object.keys(w.structures).forEach(function (s) { w.structures[s] = pyRound(w.structures[s]); });
      w.exposure_m = pyRound(w.exposure_m);
    });
    return out;
  }

  /* ---------- 단계 목록 만들기 ----------
     1) 환승 간선에서 나누고, 2) 타기 부분은 노선이 바뀌는 곳에서 다시 나누고,
     3) 지상 노출 경고를 그 노출이 시작되는 단계 바로 앞에 끼운다. 타기·환승 단계에는 1부터 번호(no). */
  function buildSteps(G, startSi, path, speedKmh) {
    const mPerMin = (speedKmh || WALK_KMH) * 1000 / 60;
    const steps = [], edgeStep = new Array(path.length).fill(0);   // 경로 안 간선 위치 -> 단계 번호
    let lastSi = startSi;
    splitParts(G, path).forEach(function (part) {
      if (part.kind === 'transfer') {
        const i = part.idx[0];
        edgeStep[i] = steps.length;
        steps.push(transferStep(G, path, i, mPerMin));
        const si = G.nodeStation[path[i].v];
        if (si >= 0) lastSi = si;
        return;
      }
      const lines = assignLines(G, path, part.idx);
      let j = 0;
      while (j < lines.length) {
        let k = j;
        while (k < lines.length && lines[k] === lines[j]) k++;
        const idx = part.idx.slice(j, k);
        idx.forEach(function (i) { edgeStep[i] = steps.length; });
        const r = rideStep(G, path, idx, lines[j], lastSi, mPerMin);
        steps.push(r.step);
        lastSi = r.last;
        j = k;
      }
    });
    steps.forEach(function (s, n) {   // 환승 단계의 노선 이름은 앞뒤 타기 단계의 노선으로
      if (s.type !== 'transfer') return;
      if (n > 0 && steps[n - 1].type === 'ride' && steps[n - 1].line) s.from_line = steps[n - 1].line;
      if (n + 1 < steps.length && steps[n + 1].type === 'ride' && steps[n + 1].line) s.to_line = steps[n + 1].line;
    });
    const warnings = exposureWarnings(G, startSi, path, edgeStep);
    const out = [];
    steps.forEach(function (s, n) {
      s.no = n + 1;
      warnings.forEach(function (w) { if (w.step === n) { w.in_step = n + 1; out.push(w); } });
      out.push(s);
    });
    warnings.forEach(function (w) { delete w.step; });
    return out;
  }

  /* ---------- 글 안내 (route.py 의 step_text 와 같은 문장) ---------- */
  const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  const STRUCT_KO = { tunnel: '터널', bridge: '교량', ground: '지상', entrance: '출입구', underground: '지하 통로' };
  const SOURCE_KO = { seoul_metro: '서울교통공사 자료', estimated: '추정', '': '' };

  function fmtMinutes(m) {
    m = Math.trunc(m);
    const h = Math.floor(m / 60), mm = m % 60;
    return h ? h + '시간 ' + mm + '분' : (mm ? mm + '분' : '1분 미만');
  }

  // 소수 1자리. 파이썬 format(.1f) 처럼 정확히 반인 값은 짝수 쪽으로(예: 1250m -> 1.2)
  // (이진수로 정확히 반이 되는 값은 x = 홀수/4 뿐이다: 0.25, 0.75, 1.25 …)
  function fixed1(x) {
    if (Number.isInteger(x * 4) && !Number.isInteger(x * 2)) return (pyRound(x * 10) / 10).toFixed(1);
    return x.toFixed(1);
  }
  function fmtKm(m) { return fixed1(m / 1000) + 'km'; }
  function circled(n) { return n <= CIRCLED.length ? CIRCLED[n - 1] : '(' + n + ')'; }

  function stepText(s) {
    if (s.type === 'warning') {
      const where = s.at + (s.after_m ? ' 지나 ' + fmtKm(s.after_m) : '');
      const kinds = Object.keys(s.structures).map(function (k) { return STRUCT_KO[k] + ' ' + fmtKm(s.structures[k]); }).join('·');
      const until = s.ends_underground ? '다시 지하로 들어갈 때까지' : '도착할 때까지';
      const how = s.portal ? '터널을 나와 ' : '';
      return ['   ※ 지상 노출 | ' + where + '에서 ' + how + until + ' ' + fmtKm(s.exposure_m) + ' (' + kinds + ')'];
    }
    const no = circled(s.no);
    if (s.type === 'transfer') {
      return [no + ' 환승 | ' + s.station + ': ' + s.from_line + ' → ' + s.to_line + ', ' + s.distance_m + 'm, 약 ' +
        fmtMinutes(s.est_minutes) + ' (' + SOURCE_KO[s.source] + ', ' + (s.underground ? '지하' : '지상') + ')'];
    }
    const nxt = s.direction.replace(' 방면', '');
    let head = s.direction;
    if (s.terminal_direction) head = s.terminal_direction + (s.terminal_direction === s.direction ? '' : '(다음 역 ' + nxt + ')');
    const passing = s.passing.map(function (p) { return p.station + ' ' + fixed1(p.at_m / 1000); }).join(', ');
    const where = head ? s.from_station + ' → ' + head + ' … ' + s.to_station + '까지' : s.from_station + ' 이후 선로를 따라 다음 단계까지';
    let text = no + ' ' + s.label + ' | ' + where + ' ' + fmtKm(s.distance_m) + ', 약 ' + fmtMinutes(s.est_minutes);
    if (s.exposure_m) text += ', 지상 노출 ' + fmtKm(s.exposure_m);
    text += passing ? ' (지나는 역: ' + passing + ')' : ' (지나는 역 없음)';
    const lines = [text];
    if (s.track_parts.length > 1) {
      lines.push('    선 구간: ' + s.track_parts.map(function (p) {
        const span = p.from_station !== p.to_station ? ' ' + p.from_station + '→' + p.to_station : '';
        return p.name + span + ' ' + fmtKm(p.distance_m);
      }).join(' · '));
    }
    return lines;
  }

  UG.steps = {
    WALK_KMH: WALK_KMH, STRUCT_KO: STRUCT_KO, SOURCE_KO: SOURCE_KO, pyRound: pyRound, isExposed: isExposed,
    describe: describe, buildSteps: buildSteps, terminalDirection: terminalDirection,
    fmtMinutes: fmtMinutes, fmtKm: fmtKm, fixed1: fixed1, circled: circled, stepText: stepText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.steps;
})(typeof globalThis !== 'undefined' ? globalThis : this);
