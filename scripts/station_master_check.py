"""서울시 역사마스터(공식 좌표)와 그래프(OSM) 역 좌표를 대조한다.

사용법(프로젝트 폴더에서): python -I scripts\\station_master_check.py
입력  : data\\raw\\station_master\\station_master_20261102.csv (CP949, 읽기만 한다)
        web\\data\\graph.json (읽기만 한다. 좌표는 정수 x 1e5)
출력  : data\\derived\\station_master_check.json, docs\\station-master-check.md
표준 라이브러리만 쓴다.

비교하는 점: 공식 좌표 대 '우리 승강장 허브' 좌표.
  - 노선이 맞은 역은 그 노선이 든 허브 중 공식 점에 가장 가까운 허브.
  - 노선을 못 맞추고 이름만 맞은 역은 그 역의 모든 허브 중 가장 가까운 허브.
  - 참고로 역 평균 위치(stations[].lat/lon)와의 거리도 JSON에 남긴다.
"""
import csv
import json
import math
import os
import re
import statistics
import unicodedata
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT, 'data', 'raw', 'station_master', 'station_master_20261102.csv')
GRAPH_PATH = os.path.join(ROOT, 'web', 'data', 'graph.json')
OUT_JSON = os.path.join(ROOT, 'data', 'derived', 'station_master_check.json')
OUT_MD = os.path.join(ROOT, 'docs', 'station-master-check.md')

FALLBACK_M = 1000      # 노선을 못 맞출 때 이름만으로 맞추는 최대 거리
OVER_M = 200
BIG_M = 500
TRACK_NEAR_M = 150     # 공식 점이 우리 선로에서 이만큼 안이면 '선로 위 같은 자리'로 본다

# 공식 호선 이름 -> 그래프 노선 이름(tables.lines)
LINE_MAP = {
    '1호선': ['1호선'], '경부선': ['1호선'], '경원선': ['1호선'], '경인선': ['1호선'], '장항선': ['1호선'],
    '2호선': ['2호선', '2호선 성수지선', '2호선 신정지선'],
    '3호선': ['3호선'], '일산선': ['3호선'],
    '4호선': ['4호선'], '과천선': ['4호선'], '안산선': ['4호선'], '진접선': ['4호선'],
    '5호선': ['5호선'], '6호선': ['6호선'], '7호선': ['7호선'], '7호선(인천)': ['7호선'],
    '8호선': ['8호선'], '별내선': ['8호선'],
    '9호선': ['9호선'], '9호선(연장)': ['9호선'],
    '분당선': ['수인분당선'], '수인선': ['수인분당선'],
    '경의중앙선': ['경의중앙선'], '중앙선': ['경의중앙선'],
    '경춘선': ['경춘선'], '경강선': ['경강선'], '서해선': ['서해선'],
    '신림선': ['신림선'], '우이신설선': ['우이신설선'], '김포골드라인': ['김포골드라인'],
    '공항철도1호선': ['공항철도'], '수도권 광역급행철도': ['GTX-A'],
    '에버라인선': ['용인경전철'], '의정부선': ['의정부경전철'],
    '신분당선': ['신분당선'], '신분당선(연장)': ['신분당선'], '신분당선(연장2)': ['신분당선'],
    '인천1호선': ['인천 1호선'], '인천2호선': ['인천 2호선'],
}
CAPITAL_REGIONS = ('서울특별시', '경기도', '인천광역시')

# 큰 차이 열 곳에 붙이는 사람 검토 메모: (공식 역ID) -> 문장. 처음 실행 때는 비어 있고, 결과를 본 뒤 채운다.
NOTES = {
    '1917': '우리 쪽이 맞는 것으로 보임. 우리 허브는 선로 위(1.2 m)이고 위키백과 좌표(37.99528, 127.07444)와 약 20 m 차이로 맞는다. 공식 점은 선로에서 718 m 떨어져 있어 공식 좌표 오류로 보임.',
    '4215': '우리 쪽이 맞는 것으로 보임. 위키백과 좌표(37.46766, 126.43415)와 약 160 m 차이인 반면 공식 점은 선로에서 1.1 km 떨어짐. 공식 좌표 오류로 보임.',
    '1876': '우리 쪽이 맞는 것으로 보임. 위키백과 좌표(37.26111, 126.88436)와 우리 허브가 약 30 m 차이로 맞는다. 공식 점은 같은 선로 위지만 역에서 약 500 m 떨어진 자리(공식 좌표 오류).',
    '1886': '공식 점은 선로 위이고 우리 승강장 부착점 두 곳 중 동쪽에서 234 m 더 간 자리. 승강장 끝 바깥이라 역사 출입구 같은 다른 기준점으로 보임. 외부 자료로는 확인 못 함.',
    '1014': '청량리는 환승역이라 허브가 넷이다. 1호선이 든 허브가 역 서쪽 끝에 있고 공식 점은 동쪽(중앙선·경춘선 승강장, 역사 쪽)에 있다. 큰 역의 기준점 차이.',
    '2563': '공식 점이 우리 5호선 선로에서 242 m 떨어짐. 승강장 기준이 아닌 다른 기준점(지상 역사·출입구)으로 보임. 외부 자료로는 확인 못 함.',
    '2649': '신내역은 6호선과 경춘선 허브가 따로 있다. 공식 점은 경춘선 쪽 승강장에서 100 m대이고 6호선 허브에서 230 m. 두 노선이 한 점을 공유하는 데서 온 차이로 보임.',
    '2731': '공식 점은 선로 위이고 우리 승강장 부착점 두 곳 중 동쪽(96 m)에 가깝다. 우리 허브는 두 점의 중간이라 승강장 중심과 끝의 차이로 보임.',
    '1510': '공식 점이 우리 선로에서 185 m 떨어짐. 지상역이라 역사 건물 기준점으로 보임. 외부 자료로는 확인 못 함.',
    '2512': '공식 점은 선로 위이고 우리 승강장에서 서쪽으로 183 m. 승강장 끝 바깥이라 출입구 같은 다른 기준점으로 보임. 외부 자료로는 확인 못 함.',
}


def norm(name):
    s = unicodedata.normalize('NFC', name)
    s = re.sub(r'\([^)]*\)?', '', s)            # 괄호와 그 안
    s = re.sub(r'[\s·ㆍ・.·]', '', s)       # 공백, 가운뎃점, 마침표
    if len(s) > 1 and s.endswith('역'):
        s = s[:-1]
    return s


def alt_keys(name):
    """괄호 안 이름들(별칭)을 정규화해서 돌려준다. 이름으로 못 맞췄을 때만 쓴다."""
    out = []
    for m in re.findall(r'\(([^)]*)\)?', unicodedata.normalize('NFC', name)):
        k = norm(m)
        if k:
            out.append(k)
    return out


def haversine(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def decode_polyline(s):
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for k in (0, 1):
            r = sh = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                r |= (b & 31) << sh
                sh += 5
                if b < 32:
                    break
            d = ~(r >> 1) if r & 1 else r >> 1
            if k == 0:
                lat += d
            else:
                lon += d
        pts.append((lat / 1e5, lon / 1e5))
    return pts


def seg_dist(p, a, b):
    """점 p와 선분 ab 사이 거리(m). 작은 범위라 평면 근사."""
    kx = 111320.0 * math.cos(math.radians(p[0]))
    ky = 110574.0
    ax, ay = (a[1] - p[1]) * kx, (a[0] - p[0]) * ky
    bx, by = (b[1] - p[1]) * kx, (b[0] - p[0]) * ky
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, -(ax * dx + ay * dy) / L))
    return math.hypot(ax + t * dx, ay + t * dy)


def pct(sorted_vals, q):
    """선형 보간 백분위수(0~1)."""
    if not sorted_vals:
        return None
    pos = (len(sorted_vals) - 1) * q
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def summarize(vals):
    v = sorted(vals)
    if not v:
        return {'n': 0}
    return {
        'n': len(v),
        'median_m': round(statistics.median(v), 1),
        'p90_m': round(pct(v, 0.9), 1),
        'max_m': round(v[-1], 1),
        'mean_m': round(sum(v) / len(v), 1),
        'over_200m': sum(1 for x in v if x > OVER_M),
        'over_500m': sum(1 for x in v if x > BIG_M),
    }


def main():
    with open(CSV_PATH, encoding='cp949', newline='') as f:
        rows = list(csv.DictReader(f))
    with open(GRAPH_PATH, encoding='utf-8') as f:
        g = json.load(f)
    T, N, E = g['tables'], g['nodes'], g['edges']
    lines = T['lines']
    line_idx = {n: i for i, n in enumerate(lines)}
    line_sets = T['line_sets']
    regions = [r['name'] for r in T['regions']]

    unknown_lines = sorted({r['호선'] for r in rows if r['호선'] not in LINE_MAP})
    mapped_targets = {line_idx[n] for r in rows for n in LINE_MAP.get(r['호선'], []) if n in line_idx}
    missing_targets = sorted({n for v in LINE_MAP.values() for n in v if n not in line_idx})

    stations = g['stations']
    st_hubs = []      # 역마다 [(허브 노드, 노선 번호 집합, lat, lon)]
    by_name = defaultdict(set)
    for si, s in enumerate(stations):
        hl = []
        for h, ls in zip(s['hubs'], s['hub_ls']):
            hl.append((h, set(line_sets[ls]), N['lat'][h] / 1e5, N['lon'][h] / 1e5))
        st_hubs.append(hl)
        for nm in [s['name']] + s.get('names', []):
            k = norm(nm)
            if k:
                by_name[k].add(si)

    def candidates(keys):
        out = set()
        for k in keys:
            out |= by_name.get(k, set())
        return out

    def best_hub(si, lat, lon, want):
        """want 노선 집합이 있으면 그 노선이 든 허브만, 없으면 모든 허브. 가장 가까운 것 (거리, 허브)."""
        best = None
        for h in st_hubs[si]:
            if want is not None and not (h[1] & want):
                continue
            d = haversine(lat, lon, h[2], h[3])
            if best is None or d < best[0]:
                best = (d, h)
        return best

    matched, unmatched_off = [], []
    used_pairs = set()          # (역 번호, 그래프 노선 번호): 공식 항목과 짝지어진 것
    used_stations = set()
    for r in rows:
        oid, oname, oline = r['지하철역ID'], r['지하철역명'], r['호선']
        lat, lon = float(r['위도']), float(r['경도'])
        want = {line_idx[n] for n in LINE_MAP.get(oline, []) if n in line_idx}
        found = None
        for keys, label in (([norm(oname)], ''), (alt_keys(oname), 'alias_')):
            if not keys:
                continue
            cands = candidates(keys)
            # 1) 이름 + 노선
            best = None
            for si in cands:
                b = best_hub(si, lat, lon, want) if want else None
                if b and (best is None or b[0] < best[0]):
                    best = (b[0], si, b[1])
            if best:
                found = (label + 'name_line', best)
                break
            # 2) 이름만, 1km 이내
            best = None
            for si in cands:
                b = best_hub(si, lat, lon, None)
                if b and b[0] <= FALLBACK_M and (best is None or b[0] < best[0]):
                    best = (b[0], si, b[1])
            if best:
                found = (label + 'name_only_1km', best)
                break
        if not found:
            unmatched_off.append({'id': oid, 'name': oname, 'line': oline, 'lat': lat, 'lon': lon})
            continue
        mtype, (d, si, hub) = found
        s = stations[si]
        used_stations.add(si)
        for li in (want & set().union(*[h[1] for h in st_hubs[si]]) if want else set()):
            used_pairs.add((si, li))
        if mtype.endswith('name_only_1km'):
            for li in want:
                used_pairs.add((si, li))
        matched.append({
            'id': oid, 'name': oname, 'line': oline, 'lat': lat, 'lon': lon,
            'match': mtype, 'station': s['name'], 'station_index': si,
            'region': regions[s['rg']],
            'hub_node': hub[0], 'hub_lines': [lines[i] for i in sorted(hub[1])],
            'hub_lat': round(hub[2], 5), 'hub_lon': round(hub[3], 5),
            'dist_hub_m': round(d, 1),
            'dist_centroid_m': round(haversine(lat, lon, s['lat'] / 1e5, s['lon'] / 1e5), 1),
        })

    # 우리 쪽 짝 없는 역: 수도권 지역에 있고, 공식 파일이 다루는 노선의 허브가 있는데 어떤 공식 항목과도 안 맞은 역
    unmatched_ours, unmatched_pairs = [], []
    for si, s in enumerate(stations):
        if regions[s['rg']] not in CAPITAL_REGIONS:
            continue
        sl = set().union(*[h[1] for h in st_hubs[si]]) if st_hubs[si] else set()
        cov = sl & mapped_targets
        if not cov:
            continue
        if si not in used_stations:
            unmatched_ours.append({'name': s['name'], 'region': regions[s['rg']], 'lines': [lines[i] for i in sorted(cov)],
                                   'lat': s['lat'] / 1e5, 'lon': s['lon'] / 1e5})
        else:
            for li in sorted(cov):
                if (si, li) not in used_pairs:
                    unmatched_pairs.append({'name': s['name'], 'region': regions[s['rg']], 'line': lines[li]})

    # 못 맞춘 공식 행: 우리 쪽 짝 없는 역 중 300m 안의 가장 가까운 역(이름이 바뀐 역 후보)
    ours_idx = [si for si, st in enumerate(stations)
                if regions[st['rg']] in CAPITAL_REGIONS and si not in used_stations
                and (set().union(*[h[1] for h in st_hubs[si]]) if st_hubs[si] else set()) & mapped_targets]
    for u in unmatched_off:
        best = None
        for si in ours_idx:
            b = best_hub(si, u['lat'], u['lon'], None)
            if b and (best is None or b[0] < best[0]):
                best = (b[0], si)
        if best and best[0] <= 300:
            u['rename_candidate'] = stations[best[1]]['name']
            u['rename_candidate_dist_m'] = round(best[0], 1)

    # 큰 차이 점검용: 그 노선 선로까지의 거리
    track_cache = {}

    def line_track(li):
        if li not in track_cache:
            segs = []
            for j in range(len(E['a'])):
                if E['k'][j] != 0 or E['svc'][j] != 0 or not E['g'][j]:
                    continue
                if li in line_sets[E['ls'][j]]:
                    pts = decode_polyline(E['g'][j])
                    segs.append(pts)
            track_cache[li] = segs
        return track_cache[li]

    def dist_to_track(lat, lon, lis):
        best = None
        p = (lat, lon)
        for li in lis:
            for pts in line_track(li):
                # 빠른 거름: 첫·끝점이 모두 3km 밖이고 선이 짧아 보이면 건너뛴다
                if min(abs(pts[0][0] - lat), abs(pts[-1][0] - lat)) > 0.2 and len(pts) < 3:
                    continue
                for a, b in zip(pts, pts[1:]):
                    d = seg_dist(p, a, b)
                    if best is None or d < best:
                        best = d
        return best

    for m in matched:
        m['track_dist_m'] = None
    ranked = sorted(matched, key=lambda x: -x['dist_hub_m'])
    check_set = [m for m in matched if m['dist_hub_m'] > BIG_M] + [m for m in ranked[:10]]
    seen = set()
    for m in check_set:
        if m['id'] in seen:
            continue
        seen.add(m['id'])
        want = {line_idx[n] for n in LINE_MAP.get(m['line'], []) if n in line_idx}
        if want:
            t = dist_to_track(m['lat'], m['lon'], want)
            m['track_dist_m'] = None if t is None else round(t, 1)
            # 우리 허브에서 그 선로까지(허브가 선로 위에서 얼마나 떨어졌나)
            th = dist_to_track(m['hub_lat'], m['hub_lon'], want)
            m['hub_track_dist_m'] = None if th is None else round(th, 1)
        # 같은 역의 다른 공식 항목 거리(노선 간 기준점 차이)
        sib = [x['dist_hub_m'] for x in matched if x['station_index'] == m['station_index'] and x['id'] != m['id']]
        m['same_station_other_rows_m'] = sorted(sib)

    # 통계
    all_d = [m['dist_hub_m'] for m in matched]
    summary = {
        'all': summarize(all_d),
        'name_line': summarize([m['dist_hub_m'] for m in matched if m['match'].endswith('name_line')]),
        'name_only_1km': summarize([m['dist_hub_m'] for m in matched if m['match'].endswith('name_only_1km')]),
        'seoul': summarize([m['dist_hub_m'] for m in matched if m['region'] == '서울특별시']),
        'centroid_all': summarize([m['dist_centroid_m'] for m in matched]),
    }
    by_region = {}
    for rg in sorted({m['region'] for m in matched}):
        by_region[rg] = summarize([m['dist_hub_m'] for m in matched if m['region'] == rg])
    by_line = {}
    for ln in sorted({m['line'] for m in matched}):
        by_line[ln] = summarize([m['dist_hub_m'] for m in matched if m['line'] == ln])
    mtypes = Counter(m['match'] for m in matched)

    big = [m for m in ranked if m['dist_hub_m'] > BIG_M]
    top10 = ranked[:10]

    result = {
        'generated_from': {
            'official': 'data/raw/station_master/station_master_20261102.csv',
            'graph': 'web/data/graph.json (osm_base %s)' % g.get('osm_base'),
        },
        'compared_point': '우리 승강장 허브(노선이 맞은 역은 그 노선 허브 중 최근접, 이름만 맞은 역은 모든 허브 중 최근접)',
        'official_rows': len(rows),
        'matched': len(matched),
        'match_types': dict(mtypes),
        'unmatched_official_count': len(unmatched_off),
        'unmatched_official': unmatched_off,
        'unmatched_ours_stations_count': len(unmatched_ours),
        'unmatched_ours_stations': unmatched_ours,
        'unmatched_ours_station_line_pairs_count': len(unmatched_pairs),
        'unmatched_ours_station_line_pairs': unmatched_pairs,
        'line_names_not_mapped': unknown_lines,
        'graph_lines_missing': missing_targets,
        'summary': summary,
        'by_region': by_region,
        'by_official_line': by_line,
        'top10': top10,
        'over_500m': big,
        'matched_rows': matched,
    }
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    write_report(result, g)
    a = summary['all']
    print('공식 %d행, 맞춤 %d, 공식쪽 못 맞춤 %d, 우리쪽 못 맞춘 역 %d(역·노선 쌍 %d)' % (
        len(rows), len(matched), len(unmatched_off), len(unmatched_ours), len(unmatched_pairs)))
    print('중앙값 %.1f m, 90%% %.1f m, 최대 %.1f m, 200m 초과 %d, 500m 초과 %d' % (
        a['median_m'], a['p90_m'], a['max_m'], a['over_200m'], a['over_500m']))
    print('맞춤 방식:', dict(mtypes))
    print('쓰지 않은 호선 이름:', unknown_lines, '/ 그래프에 없는 노선:', missing_targets)


def fm(x):
    return '-' if x is None else ('%d' % round(x) if abs(x) >= 100 else '%.1f' % x)


def reason(m):
    note = NOTES.get(m['id'])
    if note:
        return note
    td = m.get('track_dist_m')
    if m['match'].endswith('name_only_1km'):
        return '노선을 못 맞춰 이름만으로 맞춘 항목. 매칭 확인 필요.'
    if td is None:
        return '선로 거리를 못 구함. 확인 필요.'
    if td <= TRACK_NEAR_M:
        return '공식 점이 우리 %s 선로에서 %s m 안쪽. 우리 허브 위치 또는 매칭 확인 필요.' % (m['line'], fm(td))
    return '공식 점이 우리 %s 선로에서 %s m 떨어짐. 다른 기준점(역사 건물·역사무소 등)으로 보임.' % (m['line'], fm(td))


def write_report(R, g):
    S = R['summary']
    a, sd = S['all'], S['seoul']
    L = []
    w = L.append
    w('# 역 좌표 대조: 서울시 역사마스터 대 우리 그래프')
    w('')
    w('대조일 2026-11-11. 공식 자료는 서울 데이터 허브 "서울시 역사마스터 정보"(원본 서울시 교통정보 시스템 TOPIS, 적재 2026-11-02, 공공누리 제1유형)이고, 우리 자료는 OpenStreetMap에서 만든 `web\\data\\graph.json`(OSM 기준 %s)이다. 만든 스크립트는 `scripts\\station_master_check.py`, 전체 결과는 `data\\derived\\station_master_check.json`이다.' % g.get('osm_base'))
    w('')
    w('## 1. 결론 먼저')
    w('')
    w('- 공식 %d행 가운데 %d행을 우리 역에 맞췄다(이름과 노선 %d행, 이름만 %d행). 못 맞춘 공식 행은 %d행이다.' % (
        R['official_rows'], R['matched'],
        sum(v for k, v in R['match_types'].items() if k.endswith('name_line')),
        sum(v for k, v in R['match_types'].items() if k.endswith('name_only_1km')),
        R['unmatched_official_count']))
    w('- 공식 점과 우리 승강장 허브의 거리는 중앙값 %s m, 90백분위수 %s m, 최대 %s m이다. 200 m를 넘는 항목은 %d행, 500 m를 넘는 항목은 %d행이다.' % (
        fm(a['median_m']), fm(a['p90_m']), fm(a['max_m']), a['over_200m'], a['over_500m']))
    w('- 서울특별시 소재 %d행만 보면 중앙값 %s m, 90백분위수 %s m, 최대 %s m이다.' % (
        sd['n'], fm(sd['median_m']), fm(sd['p90_m']), fm(sd['max_m'])))
    w('- 우리 쪽에서 공식 항목과 짝이 없는 수도권 역은 %d곳, 역·노선 쌍으로는 %d건이다.' % (
        R['unmatched_ours_stations_count'], R['unmatched_ours_station_line_pairs_count']))
    w('- 500 m 넘는 차이와 큰 차이 상위 10곳의 판정은 4절과 5절에 적었다.')
    w('')
    w('## 2. 방법')
    w('')
    w('1. 이름 정규화: 괄호와 그 안의 글자, 공백, 가운뎃점, 마침표를 지우고 끝의 \'역\'을 뗀다. 공식 이름과 우리 `stations[].name`·`names`에 같은 규칙을 쓴다. 이름으로 못 찾으면 괄호 안 이름(예: 한성대입구(삼선교)의 삼선교)을 별칭으로 한 번 더 찾는다.')
    w('2. 노선 대응: 공식 호선 이름을 그래프 노선 이름으로 바꾼다. 선 이름으로 적힌 호선은 노선으로 옮긴다(경부선·경원선·경인선·장항선은 1호선, 일산선은 3호선, 과천선·안산선·진접선은 4호선, 별내선은 8호선, 분당선·수인선은 수인분당선, 중앙선은 경의중앙선, 공항철도1호선은 공항철도, 수도권 광역급행철도는 GTX-A, 에버라인선은 용인경전철, 의정부선은 의정부경전철, 인천1·2호선은 인천 1·2호선, 7호선(인천)은 7호선, 9호선(연장)은 9호선, 신분당선(연장)은 신분당선). 2호선은 성수지선·신정지선도 함께 본다. 노선이 맞는 허브가 있으면 이름과 노선으로 맞추고, 없으면 이름만으로 맞추되 1 km 안에 있어야 한다.')
    w('3. 비교하는 점: 우리 쪽은 **승강장 허브** 좌표다. 노선이 맞은 역은 그 노선이 든 허브 중 공식 점에 가장 가까운 것, 이름만 맞은 역은 그 역의 모든 허브 중 가장 가까운 것이다. 역 평균 위치(`stations[].lat/lon`)와의 거리는 참고로 JSON에만 남겼다.')
    w('4. 거리는 하버사인 식으로 잰다. 백분위수는 선형 보간이다.')
    w('5. 500 m를 넘는 항목과 상위 10곳은 그 노선 본선 선로까지의 거리를 따로 잰다. 공식 점이 우리 선로 %d m 안이면 같은 자리를 가리키는 것이므로 우리 허브나 매칭을 의심하고, 멀면 공식 점이 다른 기준점이라고 본다.' % TRACK_NEAR_M)
    w('6. 우리 쪽 짝 없는 역: 서울·경기·인천에 있고, 공식 파일이 다루는 노선의 허브가 있는 역 가운데 어떤 공식 항목과도 안 맞은 역.')
    w('')
    w('## 3. 결과 표')
    w('')
    w('| 구분 | 행 수 | 중앙값(m) | 90백분위수(m) | 최대(m) | 200 m 초과 | 500 m 초과 |')
    w('|---|---:|---:|---:|---:|---:|---:|')

    def row(label, s):
        if not s.get('n'):
            return '| %s | 0 | - | - | - | - | - |' % label
        return '| %s | %d | %s | %s | %s | %d | %d |' % (label, s['n'], fm(s['median_m']), fm(s['p90_m']), fm(s['max_m']), s['over_200m'], s['over_500m'])
    w(row('전체(허브 기준)', S['all']))
    w(row('이름과 노선으로 맞춘 행', S['name_line']))
    w(row('이름만으로 맞춘 행', S['name_only_1km']))
    w(row('서울특별시', S['seoul']))
    for rg, s in R['by_region'].items():
        if rg != '서울특별시':
            w(row(rg, s))
    w(row('참고: 역 평균 위치 기준 전체', S['centroid_all']))
    w('')
    w('못 맞춘 항목')
    w('')
    w('| 구분 | 수 |')
    w('|---|---:|')
    w('| 공식 행 중 우리 역을 못 찾은 행 | %d |' % R['unmatched_official_count'])
    w('| 우리 수도권 역 중 공식 짝이 없는 역 | %d |' % R['unmatched_ours_stations_count'])
    w('| 우리 역·노선 쌍 중 공식 짝이 없는 쌍(짝 있는 역 안에서) | %d |' % R['unmatched_ours_station_line_pairs_count'])
    w('')
    if R['unmatched_official']:
        w('공식 쪽 목록(오른쪽은 300 m 안에 있는 우리 쪽 짝 없는 역, 이름이 바뀐 것으로 보이는 후보):')
        w('')
        w('| 공식 역(호선) | 후보 | 거리(m) |')
        w('|---|---|---:|')
        for u in R['unmatched_official']:
            w('| %s(%s) | %s | %s |' % (u['name'], u['line'], u.get('rename_candidate', '-'), fm(u.get('rename_candidate_dist_m'))))
        w('')
    if R['unmatched_ours_stations']:
        w('우리 쪽 목록: ' + ', '.join('%s(%s)' % (u['name'], '/'.join(u['lines'])) for u in R['unmatched_ours_stations']))
        w('')
    if R['unmatched_ours_station_line_pairs']:
        w('역·노선 쌍은 공식 파일이 환승역을 한 노선으로만 싣는 경우가 많아 대부분 자료 형식 차이다(예: 청량리는 1호선만 있고 경춘선·경의중앙선·수인분당선 행이 없다). 목록:')
        w('')
        w('우리 쪽 역·노선 쌍 목록: ' + ', '.join('%s(%s)' % (u['name'], u['line']) for u in R['unmatched_ours_station_line_pairs']))
        w('')
    w('## 4. 큰 차이 10곳')
    w('')
    w('| 순위 | 공식 역(호선) | 우리 역 | 허브 거리(m) | 선로까지(m) | 판단 |')
    w('|---:|---|---|---:|---:|---|')
    for i, m in enumerate(R['top10'], 1):
        w('| %d | %s(%s) | %s | %s | %s | %s |' % (i, m['name'], m['line'], m['station'], fm(m['dist_hub_m']), fm(m.get('track_dist_m')), reason(m)))
    w('')
    w('## 5. 500 m 넘는 항목')
    w('')
    if R['over_500m']:
        w('| 공식 역(호선) | 우리 역 | 허브 거리(m) | 공식 점~선로(m) | 우리 허브~선로(m) | 판단 |')
        w('|---|---|---:|---:|---:|---|')
        for m in R['over_500m']:
            w('| %s(%s) | %s | %s | %s | %s | %s |' % (m['name'], m['line'], m['station'], fm(m['dist_hub_m']), fm(m.get('track_dist_m')), fm(m.get('hub_track_dist_m')), reason(m)))
    else:
        w('500 m를 넘는 항목은 없다.')
    w('')
    w('## 6. 한계')
    w('')
    w('- 공식 좌표가 무엇을 가리키는지(역사 건물, 승강장 중심, 역사무소) 자료에 적혀 있지 않다. 그래서 거리는 \'우리 좌표가 틀렸다\'가 아니라 \'두 자료가 같은 점을 가리키는 정도\'로만 읽어야 한다.')
    w('- 우리 그래프의 수인분당선 역 하나(37.39165, 126.74288)는 이름이 비어 있다. OSM 이름 누락으로 보이며 공식 항목과 짝지어지지 않았다.')
    w('- 위키백과 좌표는 청산·야목·인천공항2터미널 세 곳만 확인했다. 나머지 판단은 선로 거리와 승강장 위치로 추정한 것이다.')
    w('- 우리 허브는 승강장 쪽 점이고, 지상 출입구 위치와 비교하지 않았다.')
    w('- 공식 점 쪽이 틀렸을 가능성은 따로 검증하지 않았다. 선로까지 거리는 우리 OSM 선로가 맞다고 가정한 값이다.')
    w('- 이름·노선 대응표는 사람이 만든 것이라 같은 이름 역을 잘못 짝지었을 수 있다. 이름만으로 맞춘 행은 1 km 상한을 두었다.')
    w('- 우리 쪽 \'짝 없는 역\'은 서울·경기·인천에 한정했고, 공식 파일에 없는 노선(예: 인천공항 셔틀)은 세지 않았다.')
    w('- 이 파일은 하루 시점(2026-11-02 적재본) 자료이고, 신설·개명된 역은 반영이 늦을 수 있다.')
    w('')
    w('수도권 지하철 역·노선 %d건의 좌표가 서울시 공식 역사마스터와 중앙값 %s m 차이.' % (a['n'], fm(a['median_m'])))
    w('')
    with open(OUT_MD, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(L))


if __name__ == '__main__':
    main()
