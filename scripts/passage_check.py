# -*- coding: utf-8 -*-
"""서울시 지하철역 연계 지하도 공간정보(data.go.kr 15098161 / 열린데이터광장 OA-21213) 점검.

분석만 한다. graph.json·웹 파일은 읽기만 하고 바꾸지 않는다.
실행: python -I scripts\\passage_check.py
입력: data\\raw\\passage\\seoul_station_passage.csv (CP949), web\\data\\graph.json
출력: data\\derived\\passage_check.json, 화면에 요약
"""
import collections
import csv
import heapq
import json
import math
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT, 'data', 'raw', 'passage', 'seoul_station_passage.csv')
GRAPH_PATH = os.path.join(ROOT, 'web', 'data', 'graph.json')
OUT_PATH = os.path.join(ROOT, 'data', 'derived', 'passage_check.json')

FOCUS = ['서울역', '시청', '종로3가', '동대문역사문화공원', '고속터미널', '교대', '사당',
         '왕십리', '신도림', '김포공항', '공덕', '여의도']
MATCH_M = 20      # 출구 맞추기 거리
NEAR_M = 40       # 허브가 지하도 선에서 이 거리 안이면 '지하도가 그 승강장 위를 지난다'로 본다
# 지하상가·긴 지하도가 있다고 알려진 인접 역 쌍 (지하도가 역 사이를 잇는지 본다)
ARCADE_PAIRS = [('시청', '을지로입구'), ('을지로입구', '을지로3가'), ('을지로3가', '을지로4가'),
                ('을지로4가', '동대문역사문화공원'), ('종각', '종로3가'), ('종로3가', '종로5가'),
                ('명동', '회현'), ('강남', '신논현'), ('강남', '역삼'), ('잠실', '잠실새내'),
                ('삼성', '종합운동장'), ('영등포', '영등포시장'), ('고속터미널', '신반포'),
                ('서울역', '회현'), ('시청', '종각'), ('충무로', '명동')]
# 2020년(포털의 자료 기준 연도) 뒤에 열린 서울 시내 노선·역
NEW_LINES = {'신림선': '2022-05', 'GTX-A': '2024-03(수서)·2024-12(서울역)', '서해선': '2023-07(김포공항)'}
NEW_STATIONS = {'강일': '5호선 2021-03', '암사역사공원': '8호선 2024-08'}

C37 = math.cos(math.radians(37.55))
LON_START = re.compile(r'(12[4-9]|13[0-2])\.')


def dist(a, b):
    """두 점(위도, 경도) 사이 거리(m). 서울 범위라 평면 근사로 충분하다."""
    return math.hypot((a[0] - b[0]) * 111320.0, (a[1] - b[1]) * 111320.0 * C37)


def xy(p):
    return (p[1] * 111320.0 * C37, p[0] * 111320.0)


def hav(a, b):
    r = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def parse_wkt(wkt):
    """WKT 좌표를 (위도, 경도) 목록으로. 점 사이 구분자가 빠진 LINESTRING도 경도 시작 위치로 자른다."""
    body = wkt[wkt.find('(') + 1:]
    if ')' in body:
        body = body[:body.rfind(')')]
    starts = [m.start() for m in LON_START.finditer(body)]
    out = []
    for i, s in enumerate(starts):
        seg = body[s: starts[i + 1] if i + 1 < len(starts) else len(body)].strip().strip(',')
        a = seg.split()
        if len(a) >= 2:
            out.append((float(a[1]), float(a[0])))
    return out


def norm_name(s):
    s = re.sub(r'\(.*?\)', '', s).replace(' ', '')
    if s.endswith('역') and len(s) > 2:
        s = s[:-1]
    return s


def quant(v, fs=(0.1, 0.5, 0.9)):
    v = sorted(v)
    return [round(v[min(len(v) - 1, int(len(v) * f))], 2) for f in fs] if v else None


class Grid:
    def __init__(self, cell=0.0005):
        self.cell = cell
        self.g = collections.defaultdict(list)

    def key(self, p):
        return (int(p[0] / self.cell), int(p[1] / self.cell))

    def add(self, p, item):
        self.g[self.key(p)].append((p, item))

    def near(self, p, r):
        k = self.key(p)
        n = int(r / (self.cell * 111320 * C37)) + 1
        out = []
        for dx in range(-n, n + 1):
            for dy in range(-n, n + 1):
                for q, it in self.g.get((k[0] + dx, k[1] + dy), ()):
                    d = dist(p, q)
                    if d <= r:
                        out.append((d, it))
        out.sort(key=lambda x: x[0])
        return out


# ---------------------------------------------------------------- 지하도 자료 읽기
def load_passage():
    rows = list(csv.DictReader(open(CSV_PATH, encoding='cp949', newline='')))
    nodes, links = {}, []
    for r in rows:
        if r['노드링크 유형'] == 'NODE':
            nodes[r['노드 ID']] = {
                'p': parse_wkt(r['노드 WKT'])[0], 't': r['노드 유형 코드'], 'st': r['지하철역명'],
                'code': r['지하철역코드'], 'elev': r['엘리베이터'] == '1', 'lift': r['리프트'] == '1'}
    for r in rows:
        if r['노드링크 유형'] != 'LINK':
            continue
        pts = parse_wkt(r['링크 WKT'])
        if len(pts) < 2:
            continue
        calc = sum(hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
        try:
            given = float(r['링크 길이'])
        except ValueError:
            given = calc
        a, b = r['시작노드 ID'], r['종료노드 ID']
        # 노드 표에 없는 끝점(이 자료 밖 보행 네트워크 노드로 보임)은 선 끝 좌표로 만든다
        for nid, p in ((a, pts[0]), (b, pts[-1])):
            if nid not in nodes:
                nodes[nid] = {'p': p, 't': 'X', 'st': r['지하철역명'], 'code': r['지하철역코드'],
                              'elev': False, 'lift': False}
        links.append({'id': r['링크 ID'], 'a': a, 'b': b, 't': r['링크 유형 코드'], 'pts': pts,
                      'len': given, 'calc': calc, 'st': r['지하철역명']})
    return rows, nodes, links


def dijkstra(adj, src, limit=3000.0):
    best = {src: 0.0}
    pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > best.get(u, 1e18) or d > limit:
            continue
        for v, w, _ in adj[u]:
            nd = d + w
            if nd < best.get(v, 1e18):
                best[v] = nd
                heapq.heappush(pq, (nd, v))
    return best


def project(p, links, cand):
    """점 p를 링크 목록 cand에 수선으로 내린다. (거리 m, 링크 번호, a 끝에서 잰 거리 m)."""
    px, py = xy(p)
    best = None
    for li in cand:
        pts = links[li]['pts']
        along = 0.0
        for i in range(len(pts) - 1):
            ax, ay = xy(pts[i])
            bx, by = xy(pts[i + 1])
            dx, dy = bx - ax, by - ay
            seg = math.hypot(dx, dy)
            t = 0.0 if seg == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (seg * seg)))
            d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if best is None or d < best[0]:
                best = (d, li, along + t * seg)
            along += seg
    return best


def main():
    rows, N, L = load_passage()
    g = json.load(open(GRAPH_PATH, encoding='utf-8'))
    glat, glon, gf = g['nodes']['lat'], g['nodes']['lon'], g['nodes']['f']

    def gp(i):
        return (glat[i] / 1e5, glon[i] / 1e5)

    tables = g['tables']
    lines, line_sets, kinds = tables['lines'], tables['line_sets'], tables['kinds']
    seoul_rg = [i for i, r in enumerate(tables['regions']) if r['name'] == '서울특별시'][0]
    gyeonggi_rg = [i for i, r in enumerate(tables['regions']) if r['name'] == '경기도'][0]
    E = g['edges']
    stations = g['stations']
    for l in L:  # 투영과 같은 평면 근사 길이
        l['plen'] = sum(dist(l['pts'][i], l['pts'][i + 1]) for i in range(len(l['pts']) - 1))

    out = {'source': {
        'dataset': '서울특별시_서울시 지하철역 연계 지하도 공간정보',
        'data_go_kr': 'https://www.data.go.kr/data/15098161/openapi.do',
        'seoul_open_data': 'https://data.seoul.go.kr/dataList/OA-21213/S/1/datasetView.do',
        'code_table_candidate': 'https://data.seoul.go.kr/dataList/OA-21208/S/1/datasetView.do (도보네트워크_링크노드유형코드.xlsx, 내려받지 않음)',
        'reference_year_on_portal': 2020, 'registered_data_go_kr': '2022-01-11',
        'graph': 'web/data/graph.json (읽기만)'}}

    # ------------------------------------------------------------ 1. 기본 통계·유형
    real = {k: v for k, v in N.items() if v['t'] != 'X'}
    deg = collections.Counter()
    adj = collections.defaultdict(list)
    for i, l in enumerate(L):
        deg[l['a']] += 1
        deg[l['b']] += 1
        adj[l['a']].append((l['b'], l['plen'], i))
        adj[l['b']].append((l['a'], l['plen'], i))
    errs = sorted(abs(l['len'] - l['calc']) for l in L)

    ents = []  # (점, 역 번호, 출구 번호, 출입구 노드)
    for i, nid in enumerate(g['entrances']['node']):
        st = g['entrances']['station'][i]
        if stations[st]['rg'] in (seoul_rg, gyeonggi_rg):
            ents.append((gp(nid), st, g['entrances']['ref'][i], nid))
    eg = Grid()
    for e in ents:
        eg.add(e[0], e)

    def ent_d(p):
        h = eg.near(p, 80)
        return h[0][0] if h else 999.0

    types = {}
    for t in sorted({v['t'] for v in N.values()}):
        ids = [k for k, v in N.items() if v['t'] == t]
        dd = [ent_d(N[k]['p']) for k in ids]
        types[t] = {
            'count': len(ids),
            'degree(4=4+)': {str(k): v for k, v in sorted(collections.Counter(min(deg[k], 4) for k in ids).items())},
            'elevator_flag': sum(1 for k in ids if N[k]['elev']),
            'lift_flag': sum(1 for k in ids if N[k]['lift']),
            'osm_entrance_within_10m': sum(1 for x in dd if x <= 10),
            'osm_entrance_within_20m': sum(1 for x in dd if x <= 20),
            'osm_entrance_within_40m': sum(1 for x in dd if x <= 40),
            'median_m_to_osm_entrance': round(sorted(dd)[len(dd) // 2], 1)}
    ltypes = {}
    for t in sorted({l['t'] for l in L}):
        ls = [l for l in L if l['t'] == t]
        lens = sorted(l['len'] for l in ls)
        endt = collections.Counter('-'.join(sorted((N[l['a']]['t'], N[l['b']]['t']))) for l in ls)
        ltypes[t] = {'count': len(ls), 'km': round(sum(lens) / 1000, 2),
                     'median_m': round(lens[len(lens) // 2], 1), 'max_m': round(lens[-1], 1),
                     'end_node_types': dict(endt.most_common()),
                     'an_end_within_20m_of_osm_entrance': sum(
                         1 for l in ls if min(ent_d(l['pts'][0]), ent_d(l['pts'][-1])) <= 20),
                     'stations': dict(collections.Counter(l['st'] for l in ls).most_common(10))}
    label_codes = collections.defaultdict(set)
    for v in real.values():
        label_codes[v['st']].add(v['code'])
    mix = collections.Counter()
    for l in L:
        for nid in (l['a'], l['b']):
            if N[nid]['t'] != 'X' and N[nid]['st'] != l['st']:
                mix[tuple(sorted((N[nid]['st'], l['st'])))] += 1
    out['basic'] = {
        'rows': len(rows), 'nodes': len(real), 'links': len(L),
        'link_ends_not_in_node_table': sum(1 for v in N.values() if v['t'] == 'X'),
        'station_labels': len({v['st'] for v in real.values()} | {l['st'] for l in L}),
        'total_km': round(sum(l['len'] for l in L) / 1000, 2),
        'wkt_len_err_m_p50_p99': [round(errs[len(errs) // 2], 3), round(errs[int(len(errs) * 0.99)], 3)],
        'node_types': types, 'link_types': ltypes,
        'label_mismatch_link_vs_node': [list(k) + [v] for k, v in mix.most_common()],
        'labels_with_links_but_no_nodes': sorted({l['st'] for l in L} - {v['st'] for v in real.values()})}

    # ------------------------------------------------------------ 2. 연결 요소
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
    comp = collections.defaultdict(list)
    for k in N:
        comp[find(k)].append(k)
    comp_of = {k: find(k) for k in N}
    comp_links = collections.defaultdict(list)
    for i, l in enumerate(L):
        comp_links[comp_of[l['a']]].append(i)

    def extent(ids):
        ps = [N[k]['p'] for k in ids]
        return dist((min(p[0] for p in ps), min(p[1] for p in ps)), (max(p[0] for p in ps), max(p[1] for p in ps)))

    linked = [r for r in comp if comp_links[r]]
    out['components'] = {
        'count_with_links': len(linked),
        'isolated_nodes': sum(1 for r, ids in comp.items() if not comp_links[r]),
        'nodes_per_component_p10_p50_p90': quant([len(comp[r]) for r in linked]),
        'km_per_component_p10_p50_p90': quant([sum(L[i]['len'] for i in comp_links[r]) / 1000 for r in linked]),
        'extent_m_p10_p50_p90': quant([extent(comp[r]) for r in linked])}

    # ------------------------------------------------------------ 역 맞추기 (기하: 지하도 요소 → 가장 가까운 graph 역)
    st_pts = collections.defaultdict(list)  # 역 번호 → 허브·출입구 점
    for si, s in enumerate(stations):
        if s['rg'] in (seoul_rg, gyeonggi_rg):
            for h in s['hubs']:
                st_pts[si].append(gp(h))
    for e in ents:
        st_pts[e[1]].append(e[0])
    sg = Grid(0.002)
    for si, ps in st_pts.items():
        for p in ps:
            sg.add(p, si)
    comp_station = {}
    for r in linked:
        votes = collections.Counter()
        for k in comp[r]:
            h = sg.near(N[k]['p'], 300)
            if h:
                votes[h[0][1]] += 1
        comp_station[r] = votes.most_common(1)[0][0] if votes else None
    st_comps = collections.defaultdict(list)
    for r, si in comp_station.items():
        if si is not None:
            st_comps[si].append(r)

    # 허브 → 노선 이름
    hub_line, hub_st = {}, {}
    for si, s in enumerate(stations):
        for h, ls in zip(s['hubs'], s['hub_ls']):
            hub_line[h] = '/'.join(lines[x] for x in line_sets[ls]) or '(노선 없음)'
            hub_st[h] = si
    # 링크 후보 색인(꼭짓점과 중간점)
    lg = Grid(0.001)
    for i, l in enumerate(L):
        pts = l['pts']
        for j in range(len(pts)):
            lg.add(pts[j], i)
            if j + 1 < len(pts):
                lg.add(((pts[j][0] + pts[j + 1][0]) / 2, (pts[j][1] + pts[j + 1][1]) / 2), i)

    def cand_links(p, r=450, only=None):
        c = {it for _, it in lg.near(p, r)}
        if only is not None:
            c &= only
        return c

    # ------------------------------------------------------------ 3a. 노선별: 지하 허브가 지하도 선 가까이 있나 (서울)
    by_line = collections.defaultdict(lambda: [0, 0, 0])
    hub_proj = {}
    for si, s in enumerate(stations):
        if s['rg'] != seoul_rg:
            continue
        for h, ug in zip(s['hubs'], s['ug']):
            if not ug:
                continue
            pr = project(gp(h), L, cand_links(gp(h)))
            hub_proj[h] = pr
            rec = by_line[hub_line[h]]
            rec[0] += 1
            if pr and pr[0] <= NEAR_M:
                rec[1] += 1
            if pr and pr[0] <= 80:
                rec[2] += 1
    out['hub_coverage_by_line_seoul_underground'] = {
        k: {'hubs': v[0], 'within_40m': v[1], 'within_80m': v[2]}
        for k, v in sorted(by_line.items(), key=lambda kv: (-kv[1][0], kv[0]))}

    # ------------------------------------------------------------ 3b. 환승: 두 허브를 지하도 위에서 잇는 길
    def net_between(pa, pb):
        """투영점 둘 사이의 지하도 위 거리(m). 다른 요소면 None."""
        (da, la, sa), (db, lb, sb) = pa, pb
        if comp_of[L[la]['a']] != comp_of[L[lb]['a']]:
            return None
        if la == lb:
            return abs(sa - sb)
        best = None
        for end_a, off_a in ((L[la]['a'], sa), (L[la]['b'], L[la]['plen'] - sa)):
            dm = dijkstra(adj, end_a)
            for end_b, off_b in ((L[lb]['a'], sb), (L[lb]['b'], L[lb]['plen'] - sb)):
                if end_b in dm:
                    v = off_a + dm[end_b] + off_b
                    best = v if best is None or v < best else best
        return best

    k_tr = kinds.index('transfer')
    k_en = kinds.index('entrance')
    tr_edges = {}
    for j in range(len(E['a'])):
        if E['k'][j] == k_tr:
            tr_edges[frozenset((E['a'][j], E['b'][j]))] = j

    def eval_station(si, name, sink):
        s = stations[si]
        own = set()
        for r in st_comps.get(si, []):
            own |= set(comp_links[r])
        hubs = []
        projs = {}
        for h, ug in zip(s['hubs'], s['ug']):
            pr = project(gp(h), L, cand_links(gp(h), only=own)) if own else None
            projs[h] = pr
            hubs.append({'line': hub_line[h], 'underground': bool(ug),
                         'to_passage_line_m': round(pr[0], 1) if pr else None})
        pairs = []
        hs = s['hubs']
        for i in range(len(hs)):
            for j in range(i + 1, len(hs)):
                e = tr_edges.get(frozenset((hs[i], hs[j])))
                if e is None:
                    continue
                pa, pb = projs[hs[i]], projs[hs[j]]
                rec = {'from': hub_line[hs[i]], 'to': hub_line[hs[j]],
                       'graph_len_m': E['len'][e], 'graph_src': tables['sources'][E['src'][e]],
                       'hub_straight_m': round(dist(gp(hs[i]), gp(hs[j])), 1),
                       'off_from_m': round(pa[0], 1) if pa else None,
                       'off_to_m': round(pb[0], 1) if pb else None}
                nb = net_between(pa, pb) if pa and pb else None
                rec['passage_m'] = round(nb, 1) if nb is not None else None
                ok = nb is not None and pa[0] <= NEAR_M and pb[0] <= NEAR_M
                rec['covered'] = ok
                if ok:
                    rec['passage_plus_offsets_m'] = round(nb + pa[0] + pb[0], 1)
                    rec['ratio_to_graph'] = round((nb + pa[0] + pb[0]) / E['len'][e], 2)
                pairs.append(rec)
                sink.append(dict(rec, station=name))
        st = {
            'components': len(st_comps.get(si, [])),
            'links': len(own), 'km': round(sum(L[x]['len'] for x in own) / 1000, 3),
            'exits_type1': sum(1 for r in st_comps.get(si, []) for k in comp[r] if N[k]['t'] == '1'),
            'osm_entrances': sum(1 for e in ents if e[1] == si)}
        return {'structure': st, 'hubs': hubs, 'transfers': pairs}

    def summarize(pairs):
        cov = [p for p in pairs if p['covered']]
        sm = [p for p in cov if p['graph_src'] == 'seoul_metro']
        return {'pairs': len(pairs), 'covered_both_hubs_within_40m_and_connected': len(cov),
                'covered_with_seoul_metro_len': len(sm),
                'seoul_metro_ratio_0.67_to_1.5': sum(1 for p in sm if 0.67 <= p['ratio_to_graph'] <= 1.5),
                'ratio_passage_to_seoul_metro_p10_p50_p90': quant([p['ratio_to_graph'] for p in sm])}

    focus, focus_pairs = {}, []
    for name in FOCUS:
        si = [x for x, s in enumerate(stations) if s['name'] == name and s['rg'] == seoul_rg][0]
        focus[name] = eval_station(si, name, focus_pairs)
    out['focus_stations'] = focus
    out['focus_transfer_summary'] = summarize(focus_pairs)
    seoul_pairs = []
    for si, s in enumerate(stations):
        if s['rg'] == seoul_rg and len(s['hubs']) >= 2:
            eval_station(si, s['name'], seoul_pairs)
    out['seoul_transfer_summary'] = summarize(seoul_pairs)
    out['seoul_transfer_summary']['stations'] = len({p['station'] for p in seoul_pairs})
    tot = [0, 0, 0]
    for v in by_line.values():
        for i in range(3):
            tot[i] += v[i]
    out['hub_coverage_total_seoul_underground'] = {'hubs': tot[0], 'within_40m': tot[1], 'within_80m': tot[2]}

    # ------------------------------------------------------------ 4. 역 사이 연결·역 밖 통로
    hub_pts = [gp(h) for s in stations if s['rg'] in (seoul_rg, gyeonggi_rg) for h in s['hubs']]
    hg = Grid(0.002)
    for p in hub_pts:
        hg.add(p, 1)

    def hub_near_m(p):
        h = hg.near(p, 1500)
        return h[0][0] if h else 9999.0
    far = collections.Counter()
    far_ex = collections.Counter()
    for l in L:
        mid = l['pts'][len(l['pts']) // 2]
        dmh = hub_near_m(mid)
        for th in (150, 250, 400):
            if dmh > th:
                far[th] += l['len']
        if dmh > 250:
            far_ex[l['st']] += l['len']
    multi = []
    for r in linked:
        sts = set()
        for k in comp[r]:
            h = sg.near(N[k]['p'], 150)
            if h:
                sts.add(h[0][1])
        if len(sts) >= 2:
            multi.append({'stations': sorted({stations[x]['name'] for x in sts}),
                          'labels': sorted({N[k]['st'] for k in comp[r]}),
                          'km': round(sum(L[i]['len'] for i in comp_links[r]) / 1000, 3),
                          'extent_m': round(extent(comp[r]))})
    gaps = []
    for a, b in ARCADE_PAIRS:
        sa = [si for si, s in enumerate(stations) if s['name'] == a and s['rg'] == seoul_rg]
        sb = [si for si, s in enumerate(stations) if s['name'] == b and s['rg'] == seoul_rg]
        if not sa or not sb:
            gaps.append({'pair': [a, b], 'error': 'graph에 없음'})
            continue
        na = [k for r in st_comps.get(sa[0], []) for k in comp[r]]
        nb_ = [k for r in st_comps.get(sb[0], []) for k in comp[r]]
        if not na or not nb_:
            gaps.append({'pair': [a, b], 'error': '지하도 없음'})
            continue
        gmin = min(dist(N[x]['p'], N[y]['p']) for x in na for y in nb_)
        same = bool({comp_of[x] for x in na} & {comp_of[y] for y in nb_})
        hubd = dist((stations[sa[0]]['lat'] / 1e5, stations[sa[0]]['lon'] / 1e5),
                    (stations[sb[0]]['lat'] / 1e5, stations[sb[0]]['lon'] / 1e5))
        gaps.append({'pair': [a, b], 'station_center_m': round(hubd), 'closest_passage_nodes_m': round(gmin),
                     'connected': same})
    out['inter_station'] = {
        'km_link_mid_farther_than_150m_from_any_hub': round(far[150] / 1000, 2),
        'km_link_mid_farther_than_250m_from_any_hub': round(far[250] / 1000, 2),
        'km_link_mid_farther_than_400m_from_any_hub': round(far[400] / 1000, 2),
        'far_250m_by_label_m': {k: round(v) for k, v in far_ex.most_common(10)},
        'components_near_2plus_stations(150m)': multi,
        'arcade_pairs': gaps}

    # ------------------------------------------------------------ 5. 출구 맞추기와 출구 구간 길이
    ent_edge = {}
    for j in range(len(E['a'])):
        if E['k'][j] == k_en:
            a, b = E['a'][j], E['b'][j]
            if gf[a] & 4:
                ent_edge[a] = (j, b)
            elif gf[b] & 4:
                ent_edge[b] = (j, a)
    t1g = Grid()
    for k, v in real.items():
        if v['t'] == '1':
            t1g.add(v['p'], k)
    allg = Grid()
    for k, v in real.items():
        allg.add(v['p'], k)
    seoul_ents = [e for e in ents if stations[e[1]]['rg'] == seoul_rg]
    cand = []
    any_near = 0
    for e in seoul_ents:
        for d, k in t1g.near(e[0], MATCH_M):
            cand.append((d, e[3], k, e))
        if allg.near(e[0], MATCH_M):
            any_near += 1
    cand.sort(key=lambda x: x[0])
    done_e, used, matched = set(), set(), []
    for d, enode, k, e in cand:
        if enode in done_e or k in used:
            continue
        done_e.add(enode)
        used.add(k)
        matched.append((d, k, e))
    legs = []
    for d, k, e in matched:
        if e[3] not in ent_edge:
            continue
        j, hub = ent_edge[e[3]]
        own = set(comp_links[comp_of[k]])
        if not own:
            continue
        pr = project(gp(hub), L, own)
        dm = dijkstra(adj, k)
        la = L[pr[1]]
        opts = [dm[la['a']] + pr[2] if la['a'] in dm else None,
                dm[la['b']] + la['plen'] - pr[2] if la['b'] in dm else None]
        opts = [x for x in opts if x is not None]
        if not opts:
            continue
        pm = min(opts)
        legs.append({'station': stations[e[1]]['name'], 'ref': e[2], 'straight_m': E['len'][j],
                     'passage_m': round(pm, 1), 'hub_off_m': round(pr[0], 1),
                     'passage_plus_off_m': round(pm + pr[0], 1), 'match_m': round(d, 1)})
    good = [x for x in legs if x['hub_off_m'] <= NEAR_M]
    rat = [x['passage_plus_off_m'] / x['straight_m'] for x in good if x['straight_m'] > 0]
    out['exits'] = {
        'osm_entrances_seoul': len(seoul_ents),
        'type1_nodes': types['1']['count'],
        'matched_osm_to_type1_1to1_within_20m': len(matched),
        'osm_entrances_with_any_passage_node_within_20m': any_near,
        'legs_with_hub_within_40m_of_same_component': len(good),
        'straight_m_p10_p50_p90': quant([x['straight_m'] for x in good]),
        'passage_plus_off_m_p10_p50_p90': quant([x['passage_plus_off_m'] for x in good]),
        'ratio_p10_p50_p90': quant(rat),
        'ratio_over_2': sum(1 for x in rat if x > 2),
        'examples_longest_extra': sorted(good, key=lambda x: -(x['passage_plus_off_m'] - x['straight_m']))[:6]}

    # ------------------------------------------------------------ 6. 자료 시점
    labels = {v['st'] for v in real.values()} | {l['st'] for l in L}
    labels_norm = {norm_name(x) for x in labels}
    new_lines = {}
    for ln, opened in NEW_LINES.items():
        hs = [h for h in hub_proj if hub_line[h] == ln]
        new_lines[ln] = {'opened': opened, 'seoul_ug_hubs': len(hs),
                         'hubs': {stations[hub_st[h]]['name']: (round(hub_proj[h][0], 1) if hub_proj[h] else None) for h in hs}}
    new_st = {}
    for nm, opened in NEW_STATIONS.items():
        new_st[nm] = {'opened': opened, 'label_in_data': norm_name(nm) in labels_norm}
    seoul_ug = [si for si, s in enumerate(stations) if s['rg'] == seoul_rg and any(s['ug'])]
    no_comp = sorted(stations[si]['name'] for si in seoul_ug if si not in st_comps)
    out['data_age'] = {'new_lines_hub_to_passage_m': new_lines, 'new_stations': new_st,
                       'graph_seoul_underground_stations': len(seoul_ug),
                       'graph_seoul_underground_without_passage_component': no_comp}

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    # ------------------------------------------------------------ 요약 출력
    print(json.dumps({k: out[k] for k in ('basic', 'components')}, ensure_ascii=False))
    print('LINES', json.dumps(out['hub_coverage_by_line_seoul_underground'], ensure_ascii=False))
    for name, v in focus.items():
        print('==', name, v['structure'], [(h['line'], h['to_passage_line_m']) for h in v['hubs']])
        for p in v['transfers']:
            print('   ', p['from'], '->', p['to'], p['graph_src'], p['graph_len_m'], '| off', p['off_from_m'], p['off_to_m'],
                  '| passage', p['passage_m'], '| covered', p['covered'], p.get('passage_plus_offsets_m'), p.get('ratio_to_graph'))
    print('XFER focus', out['focus_transfer_summary'])
    print('XFER seoul', out['seoul_transfer_summary'])
    print('HUB total', out['hub_coverage_total_seoul_underground'])
    print('INTER', json.dumps(out['inter_station'], ensure_ascii=False))
    print('EXITS', json.dumps(out['exits'], ensure_ascii=False))
    print('AGE', json.dumps(out['data_age'], ensure_ascii=False))


if __name__ == '__main__':
    main()
