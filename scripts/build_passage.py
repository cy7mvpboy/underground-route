# -*- coding: utf-8 -*-
"""역 안 지하도 선 모양 자료(web/data/passage.json) 만들기.

원본: 서울특별시_서울시 지하철역 연계 지하도 공간정보(data.go.kr 15098161, 이용허락범위 제한 없음,
내용은 2021년 무렵). 분석과 판정 근거는 docs/passage-data-check.md, 형식은 docs/graph-format.md 의
'passage.json' 절에 있다.

하는 일 (그림용 자료만 만든다. graph.json·탐색 거리는 바꾸지 않는다)
- exits: 출구 구간(A1). OSM 출입구와 지하도 노드 유형 1(출구 끝점)을 20m 안에서 가까운 쌍부터
  1:1로 맞춘다(passage_check.py 와 같은 규칙). 그 출입구의 entrance 간선 허브를 같은 지하도 요소에
  수선으로 내려 40m 안이면, 출구 노드 → 그 투영점까지 지하도 위 최단 경로를 폴리라인으로 만든다.
  방향: 출입구(graph 좌표) → 역(허브 위 지하도 지점).
- transfers: 환승(B1). 같은 역 지하도 요소에 두 허브를 내려 둘 다 40m 안이고 서로 이어져 있으면,
  두 투영점 사이 지하도 위 최단 경로. 방향: 환승 간선의 a 허브 쪽 → b 허브 쪽.
  두 허브가 지하도의 같은 지점에 내려앉은 쌍, 지하도 길이가 환승 간선 길이에 비해 터무니없는 쌍
  (MIN_PASSAGE_M, MAX_RATIO_TO_EDGE, MAX_DETOUR…)은 뺀다.
- 자료 뒤에 열린 승강장(NEW_LINES, NEW_LINE_AT) 허브로 가는 출구 구간·환승은 만들지 않는다.
- 역은 CSV의 역 이름이 아니라 위치로 정한다(역 이름표 오류가 있음, 분석 문서 2.3절).
- 폴리라인은 graph.json 과 같은 Google 인코딩(소수 5자리)이라 웹의 decodePolyline 으로 푼다.

실행: python -I scripts\\build_passage.py   (표준 라이브러리만, 몇 초)
입력: data\\raw\\passage\\seoul_station_passage.csv (CP949), web\\data\\graph.json (읽기만)
출력: web\\data\\passage.json, data\\derived\\passage_report.json (통계·뺀 환승 목록)
"""
import collections
import gzip
import heapq
import json
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))  # -I 모드에서도 옆 스크립트를 불러오기 위해
import passage_check as pc  # noqa: E402  (WKT 읽기·평면 거리·격자·수선 투영, CSV 경로)
from build_graph import douglas_peucker, encode_polyline  # noqa: E402  (graph.json 과 같은 인코딩)

GRAPH_PATH = os.path.join(ROOT, 'web', 'data', 'graph.json')
OUT_PATH = os.path.join(ROOT, 'web', 'data', 'passage.json')
REPORT_PATH = os.path.join(ROOT, 'data', 'derived', 'passage_report.json')

SOURCE = {'name': '서울시 지하철역 연계 지하도 공간정보',
          'url': 'https://www.data.go.kr/data/15098161/openapi.do',
          'license': '이용허락범위 제한 없음', 'as_of': '2021년 무렵'}

MATCH_M = 20.0       # OSM 출입구 ↔ 지하도 출구 끝점(노드 유형 1) 맞추기 거리
NEAR_M = 40.0        # 허브가 지하도 선에서 이 거리 안이면 '지하도가 그 승강장 위를 지난다'
SIMPLIFY_M = 1.5     # 선 모양 단순화 허용 오차(더글러스-포이커)
STATION_VOTE_M = 300  # 지하도 연결 요소를 역에 맞출 때 쓰는 거리(passage_check.py 와 같음)
# 환승 경로를 빼는 규칙(하나라도 맞으면 뺀다). 분석 문서 4절: 지하도 길이는 대합실 수준 도식이라
# 서울교통공사 거리의 0.31~2.82배로 흩어진다. 그림으로는 쓰되, 아래처럼 터무니없는 것은 뺀다.
MAX_RATIO_TO_EDGE = 3.0   # (지하도 길이 + 두 수선) ÷ graph 환승 간선 길이
MAX_DETOUR = 4.0          # 지하도 길이 ÷ 두 투영점 사이 직선 거리 (직선이 DETOUR_MIN_STRAIGHT_M 이상일 때만)
DETOUR_MIN_STRAIGHT_M = 20.0
MAX_DETOUR_SHORT_M = 150.0  # 두 투영점이 20m 안으로 붙어 있는데 지하도로 이만큼 넘게 돌면 뺀다
MIN_PASSAGE_M = 5.0         # 두 허브가 지하도의 같은 지점(대개 통로 끝)에 내려앉아 그릴 선이 없으면 뺀다
# 자료(2021년 무렵) 뒤에 열린 승강장. 이 허브 근처의 지하도는 옛 노선 통로일 뿐이라(분석 문서 2.5·7절)
# 이 허브로 가는 출구 구간과 이 허브가 낀 환승은 만들지 않는다.
NEW_LINES = {'신림선': '2022-05', '서해선': '2023-07', 'GTX-A': '2024-03'}
NEW_LINE_AT = {('신분당선', '신사'): '2022-05', ('신분당선', '논현'): '2022-05',
               ('GTX-A', '서울역'): '2024-12', ('GTX-A', '연신내'): '2024-12'}  # 역별 개통이 다른 것(먼저 본다)


# ---------------------------------------------------------------- 지하도 그물
def shortest_tree(adj, src, limit=3000.0):
    """src 에서 다익스트라. (거리, 이전) — 이전[v] = (u, 링크 번호)."""
    best, prev = {src: 0.0}, {}
    pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > best.get(u, 1e18) or d > limit:
            continue
        for v, w, li in adj[u]:
            nd = d + w
            if nd < best.get(v, 1e18):
                best[v] = nd
                prev[v] = (u, li)
                heapq.heappush(pq, (nd, v))
    return best, prev


def node_path_pts(L, prev, src, dst):
    """src → dst 노드 경로를 따라 링크 선 모양을 이어 붙인 점 목록(src 쪽부터)."""
    chain = []
    v = dst
    while v != src:
        u, li = prev[v]
        chain.append((u, v, li))
        v = u
    pts = []
    for u, v, li in reversed(chain):
        seg = L[li]['pts'] if L[li]['a'] == u else list(reversed(L[li]['pts']))
        pts.extend(seg if not pts else seg[1:])
    return pts


def cum_along(pts):
    """선 위 누적 거리(m, passage_check.dist 와 같은 평면 근사 = 투영 거리와 같은 척도)."""
    c = [0.0]
    for i in range(len(pts) - 1):
        c.append(c[-1] + pc.dist(pts[i], pts[i + 1]))
    return c


def point_at(pts, cum, s):
    s = max(0.0, min(cum[-1], s))
    for i in range(len(pts) - 1):
        if cum[i + 1] >= s:
            seg = cum[i + 1] - cum[i]
            t = 0.0 if seg == 0 else (s - cum[i]) / seg
            return (pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1]))
    return pts[-1]


def link_part(link, s0, s1):
    """링크 위 a 끝에서 잰 거리 s0 → s1 구간의 점 목록(s0 쪽부터, 양 끝 포함)."""
    pts, cum = link['pts'], link['cum']
    lo, hi = min(s0, s1), max(s0, s1)
    out = [point_at(pts, cum, lo)]
    out += [pts[i] for i in range(len(pts)) if lo < cum[i] < hi]
    out.append(point_at(pts, cum, hi))
    return out if s0 <= s1 else list(reversed(out))


def join(*parts):
    """점 목록들을 이어 붙이고 겹친 점(0.1m 안)을 뺀다."""
    out = []
    for part in parts:
        for p in part:
            if not out or pc.dist(out[-1], p) > 0.1:
                out.append(p)
    return out


def length(pts):
    return sum(pc.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def detour_dev(pts):
    """선이 양 끝을 잇는 직선에서 가장 멀리 벗어난 거리(m)."""
    (ax, ay), (bx, by) = pc.xy(pts[0]), pc.xy(pts[-1])
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    best = 0.0
    for p in pts:
        x, y = pc.xy(p)
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / seg2))
        best = max(best, ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2) ** 0.5)
    return best


def encode(pts):
    return encode_polyline(douglas_peucker(pts, SIMPLIFY_M))


def main():
    _rows, N, L = pc.load_passage()
    for l in L:
        l['cum'] = cum_along(l['pts'])
        l['plen'] = l['cum'][-1]
    adj = collections.defaultdict(list)
    for i, l in enumerate(L):
        if l['a'] == l['b']:
            continue  # 고리 링크는 최단 경로에 쓸 일이 없다
        adj[l['a']].append((l['b'], l['plen'], i))
        adj[l['b']].append((l['a'], l['plen'], i))

    with open(GRAPH_PATH, encoding='utf-8') as f:
        g = json.load(f)
    glat, glon, gf = g['nodes']['lat'], g['nodes']['lon'], g['nodes']['f']

    def gp(i):
        return (glat[i] / 1e5, glon[i] / 1e5)

    tables, E, stations, ENT = g['tables'], g['edges'], g['stations'], g['entrances']
    region = {name: i for i, name in enumerate(r['name'] for r in tables['regions'])}
    near_rg = (region['서울특별시'], region['경기도'])
    k_tr, k_en = tables['kinds'].index('transfer'), tables['kinds'].index('entrance')

    # ------------------------------------------------------------ 연결 요소와 역(위치 투표)
    parent = {k: k for k in N}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for l in L:
        ra, rb = find(l['a']), find(l['b'])
        if ra != rb:
            parent[ra] = rb
    comp_of = {k: find(k) for k in N}
    comp_nodes, comp_links = collections.defaultdict(list), collections.defaultdict(list)
    for k in N:
        comp_nodes[comp_of[k]].append(k)
    for i, l in enumerate(L):
        comp_links[comp_of[l['a']]].append(i)

    st_grid = pc.Grid(0.002)
    for si, s in enumerate(stations):
        if s['rg'] in near_rg:
            for h in s['hubs']:
                st_grid.add(gp(h), si)
    for i, nid in enumerate(ENT['node']):
        if stations[ENT['station'][i]]['rg'] in near_rg:
            st_grid.add(gp(nid), ENT['station'][i])
    st_links = collections.defaultdict(set)  # 역 번호 → 그 역에 맞춘 요소들의 링크
    for r, links in comp_links.items():
        votes = collections.Counter()
        for k in comp_nodes[r]:
            hit = st_grid.near(N[k]['p'], STATION_VOTE_M)
            if hit:
                votes[hit[0][1]] += 1
        if votes:
            st_links[votes.most_common(1)[0][0]].update(links)

    hub_st, hub_line = {}, {}
    for si, s in enumerate(stations):
        for h, ls in zip(s['hubs'], s['hub_ls']):
            hub_st[h] = si
            hub_line[h] = '/'.join(tables['lines'][x] for x in tables['line_sets'][ls]) or '(노선 없음)'

    def opened_after_data(h):
        """허브 h 의 노선이 자료 뒤에 열렸으면 '노선 개통연월', 아니면 None."""
        for ln in hub_line[h].split('/'):
            when = NEW_LINE_AT.get((ln, stations[hub_st[h]]['name'])) or NEW_LINES.get(ln)
            if when:
                return f'{ln} {when}'
        return None

    # ------------------------------------------------------------ 출구 구간
    ent_index = {nid: i for i, nid in enumerate(ENT['node'])}
    ent_edge = {}  # 출입구 번호 → (간선 번호, 허브)
    for j in range(len(E['a'])):
        if E['k'][j] == k_en:
            a, b = E['a'][j], E['b'][j]
            if gf[a] & 4 and a in ent_index:
                ent_edge[ent_index[a]] = (j, b)
            elif gf[b] & 4 and b in ent_index:
                ent_edge[ent_index[b]] = (j, a)
    t1_grid = pc.Grid()
    for k, v in N.items():
        if v['t'] == '1':
            t1_grid.add(v['p'], k)
    cand = []
    seoul_ents = [i for i in range(len(ENT['node'])) if stations[ENT['station'][i]]['rg'] == region['서울특별시']]
    for i in seoul_ents:
        for d, k in t1_grid.near(gp(ENT['node'][i]), MATCH_M):
            cand.append((d, i, k))
    cand.sort(key=lambda x: (x[0], x[1], x[2]))
    done_e, used, matched = set(), set(), []
    for d, i, k in cand:
        if i in done_e or k in used:
            continue
        done_e.add(i)
        used.add(k)
        matched.append((d, i, k))

    exits, exit_rows = {}, []
    exit_skip, exit_new_line = collections.Counter(), collections.Counter()
    for d, i, k in sorted(matched, key=lambda x: x[1]):
        if i not in ent_edge:
            exit_skip['no_entrance_edge'] += 1
            continue
        j, hub = ent_edge[i]
        if opened_after_data(hub):
            exit_skip['hub_line_opened_after_data'] += 1
            exit_new_line[f'{stations[ENT["station"][i]]["name"]} {opened_after_data(hub)}'] += 1
            continue
        own = comp_links[comp_of[k]]
        if not own:
            exit_skip['isolated_node'] += 1
            continue
        off, li, s = pc.project(gp(hub), L, own)
        if off > NEAR_M:
            exit_skip['hub_farther_than_40m'] += 1
            continue
        dm, prev = shortest_tree(adj, k)
        link = L[li]
        best = None
        for end, part in ((link['a'], link_part(link, 0.0, s)), (link['b'], link_part(link, link['plen'], s))):
            if end in dm:
                tot = dm[end] + length(part)
                if best is None or tot < best[0]:
                    best = (tot, node_path_pts(L, prev, k, end) if end != k else [N[k]['p']], part)
        if best is None:
            exit_skip['no_path'] += 1
            continue
        pts = join([gp(ENT['node'][i])], best[1], best[2])  # 첫 점 = graph 출입구 좌표
        if len(pts) < 2:
            pts = [gp(ENT['node'][i]), best[2][-1]]
        exits[str(i)] = encode(pts)
        exit_rows.append({'entrance': i, 'station': stations[ENT['station'][i]]['name'], 'ref': ENT['ref'][i],
                          'edge': j, 'straight_m': E['len'][j], 'passage_m': round(best[0], 1),
                          'match_m': round(d, 1), 'hub_off_m': round(off, 1),
                          'elevator_node': N[k]['elev']})

    # ------------------------------------------------------------ 환승
    transfers, xfer_rows, xfer_skipped = {}, [], []
    proj_cache = {}

    def hub_proj(h):
        if h not in proj_cache:
            own = st_links.get(hub_st[h])
            proj_cache[h] = pc.project(gp(h), L, own) if own else None
        return proj_cache[h]

    pairs_considered = 0
    for j in range(len(E['a'])):
        if E['k'][j] != k_tr:
            continue
        ha, hb = E['a'][j], E['b'][j]
        si = hub_st.get(ha)
        if si is None or hub_st.get(hb) != si or stations[si]['rg'] not in near_rg:
            continue
        pairs_considered += 1
        pa, pb = hub_proj(ha), hub_proj(hb)
        if not pa or not pb or pa[0] > NEAR_M or pb[0] > NEAR_M:
            continue
        la, lb = L[pa[1]], L[pb[1]]
        if comp_of[la['a']] != comp_of[lb['a']]:
            continue
        best = None
        if pa[1] == pb[1]:
            part = link_part(la, pa[2], pb[2])
            best = (length(part), part)
        for end_a, part_a in ((la['a'], link_part(la, pa[2], 0.0)), (la['b'], link_part(la, pa[2], la['plen']))):
            dm, prev = shortest_tree(adj, end_a)
            for end_b, part_b in ((lb['a'], link_part(lb, 0.0, pb[2])), (lb['b'], link_part(lb, lb['plen'], pb[2]))):
                if end_b not in dm:
                    continue
                tot = length(part_a) + dm[end_b] + length(part_b)
                if best is None or tot < best[0] - 1e-6:
                    mid = node_path_pts(L, prev, end_a, end_b) if end_b != end_a else []
                    best = (tot, join(part_a, mid, part_b))
        if best is None:
            continue
        passage_m, pts = best
        if len(pts) < 2:  # 두 투영점이 0.1m 안으로 겹침(두 승강장이 지도에서 겹치는 역)
            pts = pts * 2
        straight = pc.dist(pts[0], pts[-1])
        ratio = (passage_m + pa[0] + pb[0]) / E['len'][j] if E['len'][j] > 0 else 99.0
        detour = passage_m / straight if straight > 0 else 99.0
        row = {'edge': j, 'station': stations[si]['name'], 'region': tables['regions'][stations[si]['rg']]['name'],
               'a': hub_line[ha], 'b': hub_line[hb],
               'graph_len_m': E['len'][j], 'graph_src': tables['sources'][E['src'][j]],
               'passage_m': round(passage_m, 1), 'off_a_m': round(pa[0], 1), 'off_b_m': round(pb[0], 1),
               'ratio_to_edge': round(ratio, 2), 'straight_between_points_m': round(straight, 1),
               'detour': round(detour, 2), 'max_dev_m': round(detour_dev(pts), 1)}
        why = []
        newer = [x for x in (opened_after_data(ha), opened_after_data(hb)) if x]
        if newer:
            why.append(f'자료 뒤에 열린 승강장({", ".join(newer)}): 근처 지하도는 옛 노선 통로')
        if passage_m < MIN_PASSAGE_M:
            why.append(f'두 허브가 지하도의 같은 지점에 내려앉음(지하도 {passage_m:.1f}m, 수선 {pa[0]:.0f}·{pb[0]:.0f}m)')
        if ratio > MAX_RATIO_TO_EDGE:
            why.append(f'지하도+수선 {passage_m + pa[0] + pb[0]:.0f}m 이 환승 간선 {E["len"][j]}m 의 {ratio:.2f}배(>{MAX_RATIO_TO_EDGE})')
        if straight >= DETOUR_MIN_STRAIGHT_M and detour > MAX_DETOUR:
            why.append(f'투영점 사이 직선 {straight:.0f}m 를 지하도로 {passage_m:.0f}m({detour:.1f}배, >{MAX_DETOUR}) 돌아감')
        if straight < DETOUR_MIN_STRAIGHT_M and passage_m > MAX_DETOUR_SHORT_M:
            why.append(f'투영점이 {straight:.0f}m 로 붙어 있는데 지하도로 {passage_m:.0f}m 돌아감')
        if why:
            row['skip_reason'] = '; '.join(why)
            xfer_skipped.append(row)
            continue
        transfers[str(j)] = encode(pts)
        xfer_rows.append(row)

    # ------------------------------------------------------------ 쓰기
    out = {'format': 'passage-1', 'precision': 5, 'source': SOURCE,
           'exits': dict(sorted(exits.items(), key=lambda kv: int(kv[0]))),
           'transfers': dict(sorted(transfers.items(), key=lambda kv: int(kv[0])))}
    raw = json.dumps(out, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    with open(OUT_PATH, 'wb') as f:
        f.write(raw)
    gz = len(gzip.compress(raw, 9))

    ratios = [r['passage_m'] / r['straight_m'] for r in exit_rows if r['straight_m'] > 0]
    report = {
        'source': SOURCE, 'output': 'web/data/passage.json', 'bytes': len(raw), 'gzip_bytes': gz,
        'rules': {'match_m': MATCH_M, 'near_m': NEAR_M, 'simplify_m': SIMPLIFY_M,
                  'max_ratio_to_edge': MAX_RATIO_TO_EDGE, 'max_detour': MAX_DETOUR,
                  'detour_min_straight_m': DETOUR_MIN_STRAIGHT_M, 'max_detour_short_m': MAX_DETOUR_SHORT_M,
                  'min_passage_m': MIN_PASSAGE_M},
        'exits': {'seoul_osm_entrances': len(seoul_ents), 'matched_1to1_within_20m': len(matched),
                  'written': len(exits), 'not_written': dict(exit_skip),
                  'opened_after_data_by_station': dict(exit_new_line.most_common()),
                  'elevator_flag_nodes_written': sum(1 for r in exit_rows if r['elevator_node']),
                  'passage_m_p10_p50_p90': pc.quant([r['passage_m'] for r in exit_rows]),
                  'passage_over_straight_p10_p50_p90': pc.quant(ratios),
                  'passage_over_2x_straight': sum(1 for x in ratios if x > 2)},
        'transfers': {'pairs_seoul_gyeonggi': pairs_considered,
                      'both_hubs_within_40m_and_connected': len(xfer_rows) + len(xfer_skipped),
                      'written': len(transfers), 'skipped': len(xfer_skipped),
                      'skipped_list': xfer_skipped, 'written_list': xfer_rows}}
    os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)
    with open(REPORT_PATH, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)

    print(f'passage.json: {len(raw):,} byte, gzip {gz:,} byte')
    print('exits', json.dumps(report['exits'], ensure_ascii=False))
    print('transfers', {k: v for k, v in report['transfers'].items() if not k.endswith('_list')})
    for r in xfer_skipped:
        print('  뺌', r['edge'], r['station'], r['a'], '↔', r['b'], '|', r['skip_reason'])


if __name__ == '__main__':
    main()
