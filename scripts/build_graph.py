# build_graph.py
# 하는 일: OSM 철도 선로·역·정차 위치·출입구와 서울교통공사 환승 거리 자료로
#          웹에서 쓸 전국 경로 탐색 그래프(web\data\graph.json)를 만든다.
#   1) 선로 그래프: 선로(way)를 끝점·분기점·구조 변화점(터널↔교량↔지상)·역 부착점에서 자른다.
#   2) 역: 선로 위 정차 위치(stop_position)를 우선 쓰고, 없으면 200m 안의 가까운 본선 선로에 붙인다.
#   3) 승강장 허브와 환승: 역마다 노선별 허브 노드를 두고 부착점을 허브에 잇는다(같은 노선 상·하행은 허브로 오간다).
#      같은 이름(500m 안)의 역은 한 역으로 묶고, 그 안의 허브끼리 환승 간선을 둔다.
#      거리는 서울교통공사 자료가 있으면 그 값, 없으면 추정(직선 × 1.3 + 50m).
#   4) 출입구: subway_entrance를 300m 안의 역 허브에 잇는다(지상 → 지하 진입점).
#   5) 속성이 같은 선로가 이어지는 중간 점(차수 2)은 없애 그래프를 줄인다.
#   6) 좌표를 줄여(더글러스-포이커 5m, 소수 5자리) 압축 JSON으로 저장하고, 점검 결과를 report로 남긴다.
#   7) 이름: 간선마다 운행 노선(예: 3호선, LINE_TABLE로 통일)과 선로의 선 이름(예: 일산선)을 따로 담고,
#      노선 relation의 정차역 순서(line_routes)를 남겨 길 안내에서 '오금 방면' 같은 방면을 찾게 한다.
#   8) 역 깊이: 서울교통공사 역 깊이 자료(1~8호선, 9호선 2·3단계 언주~중앙보훈병원)를 역·노선에 맞춰
#      stations[].depth로 남긴다(자료가 있는 역만).
# 사용법(프로젝트 폴더에서): python -I scripts\build_graph.py
# 지하 판정: tunnel 태그가 있고 no가 아니면 지하. layer<0만 있는 선로는 지상으로 둔다(docs\data-check.md 4.4절).
import csv
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict

WAYS = "data/derived/ways_kr.json"
STATIONS = "data/raw/stations.json"
STOPS = "data/raw/stops.json"            # 정차 위치 노드 + stop_area relation
ENTRANCES = "data/raw/entrances.json"
ROUTES = "data/raw/routes.json"
HAN_RIVER = "data/raw/han_river.json"
SEOUL_TRANSFER = "data/raw/seoul/transfer_distance_20250331.csv"
# 서울교통공사 역사심도정보: 1~8호선(OA-13305), 9호선 2·3단계(OA-22446). 두 파일의 열 순서가 같다
SEOUL_DEPTH = ("data/raw/seoul/station_depth_20241104.csv", "data/raw/seoul9/station_depth9_20260131.csv")
OUT_GRAPH = "web/data/graph.json"
OUT_REPORT = "data/derived/graph_report.json"

EXCLUDED_REGIONS = {"제주특별자치도"}
CONFIDENCE = {  # 지역별 데이터 신뢰도 (docs\data-check.md 6절)
    "서울특별시": "good", "인천광역시": "good", "경기도": "good",
    "부산광역시": "good", "대구광역시": "good", "대전광역시": "good",
    "전남광주통합특별시": "caveat", "울산광역시": "caveat", "세종특별자치시": "caveat",
    "강원특별자치도": "caveat", "경상북도": "caveat", "경상남도": "caveat",
    "충청북도": "unchecked", "충청남도": "unchecked", "전북특별자치도": "unchecked",
}
SERVICE_SIDE = {"yard", "siding", "spur", "crossover"}
STRUCTS = ["tunnel", "bridge", "ground", "entrance", "underground"]  # 앞의 셋은 선로, 뒤의 둘은 보행 연결
UNDER_STRUCTS = {"tunnel", "entrance", "underground"}                # 경로 비용 가중치 1인 구조
KINDS = ["track", "platform", "transfer", "entrance"]  # platform = 부착점 ↔ 승강장 허브
# 노드 표시(비트): 1 터널 출입구(갱구), 2 역 부착점(선로 위), 4 출입구(지상 쪽 끝), 8 승강장 허브
SOURCES = ["", "seoul_metro", "estimated"]
RAILWAYS = ["rail", "subway", "light_rail", "monorail", "narrow_gauge"]
SERVICES = ["", "yard", "siding", "spur", "crossover"]

SNAP_RADIUS_M = 200      # 역 → 선로 부착 최대 거리
SNAP_EXTRA_M = 40        # 가장 가까운 선로보다 이만큼 더 먼 선로까지 함께 붙인다(상·하행 선로)
STOP_SNAP_M = 30         # 선로 밖에 찍힌 정차 위치의 부착 거리
GROUP_RADIUS_M = 500     # 같은 이름 역을 한 환승역으로 묶는 거리
ENTRANCE_RADIUS_M = 300  # 출입구 → 역 연결 거리
DP_TOLERANCE_M = 5       # 선 모양 단순화 허용 오차


def est_transfer_m(d):
    """추정 환승 거리: 직선 거리 × 1.3 + 50m (통로가 굽고 계단이 있는 것을 대략 반영)."""
    return d * 1.3 + 50


# ---------- 기본 도구 ----------

def haversine_m(a, b):
    """두 점 (lat, lon) 사이의 거리(m)."""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def to_xy(p, origin):
    """origin 근처의 위경도를 평면 좌표(m)로 바꾼다(좁은 범위 근사)."""
    return ((p[1] - origin[1]) * 111320 * math.cos(math.radians(origin[0])), (p[0] - origin[0]) * 110574)


def normalize_name(s):
    """역 이름 비교용: 괄호 내용·공백·끝의 '역'을 뺀다. 예) '서울역 (KTX)' → '서울'."""
    s = re.sub(r"\(.*?\)", "", s or "").replace(" ", "")
    if len(s) > 2 and s.endswith("역"):
        s = s[:-1]
    return s


def name_variants(tags):
    names = [tags.get("name"), tags.get("name:ko")] + (tags.get("alt_name") or "").split(";")
    return {normalize_name(n) for n in names if n and normalize_name(n)}


class UnionFind:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def douglas_peucker(pts, tol_m):
    """선 모양 단순화: 양 끝을 잇는 직선에서 tol_m 이상 벗어난 점만 남긴다."""
    if len(pts) < 3:
        return pts
    xy = [to_xy(p, pts[0]) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = xy[i], xy[j]
        dx, dy = x2 - x1, y2 - y1
        seg2 = dx * dx + dy * dy
        best, best_d = -1, tol_m
        for k in range(i + 1, j):
            x, y = xy[k]
            t = 0 if seg2 == 0 else max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / seg2))
            d = math.hypot(x - x1 - t * dx, y - y1 - t * dy)
            if d > best_d:
                best, best_d = k, d
        if best >= 0:
            keep[best] = True
            stack += [(i, best), (best, j)]
    return [p for p, k in zip(pts, keep) if k]


def encode_polyline(pts):
    """Google 인코딩 폴리라인(소수 5자리). JS에서 20줄 정도로 풀 수 있다."""
    out, plat, plon = [], 0, 0
    for lat, lon in pts:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def read_cp949_csv(path):
    with open(path, encoding="cp949", newline="") as f:
        rows = list(csv.reader(f))
    return rows[1:]


# ---------- 노선 이름 ----------
# 노선(운행 계통) 이름표: (정식 이름, 짧은 이름, OSM에 나오는 다른 이름들)
#   - 정식 이름은 전국에서 하나뿐이다. 수도권은 '1호선'처럼 쓰고, 다른 도시는 '부산 1호선'처럼 도시 이름을 붙인다.
#   - 짧은 이름은 안내 화면에 쓴다(지선은 본선 번호만: '2호선 성수지선' → '2호선').
#   - 다른 이름: relation 이름(정리 후)이나 선로(way) 이름 중 이 노선을 가리키는 것. 같은 노선이 두 이름으로 나오지 않게 합친다.
#   - 표에 없는 이름(예: 경부선, 경부고속선)은 그대로 정식·짧은 이름으로 쓴다.
LINE_TABLE = [
    ("1호선", "1호선", ["수도권 전철 1호선", "서울 지하철 1호선"]),
    ("2호선", "2호선", ["서울 지하철 2호선"]),
    ("2호선 성수지선", "2호선", ["서울 지하철 2호선 성수지선"]),
    ("2호선 신정지선", "2호선", ["서울 지하철 2호선 신정지선"]),
    ("3호선", "3호선", ["수도권 전철 3호선", "서울 지하철 3호선"]),
    ("4호선", "4호선", ["수도권 전철 4호선", "서울 지하철 4호선"]),
    ("5호선", "5호선", ["서울 지하철 5호선"]),
    ("6호선", "6호선", ["서울 지하철 6호선"]),
    ("7호선", "7호선", ["서울 지하철 7호선"]),
    ("8호선", "8호선", ["서울 지하철 8호선"]),
    ("9호선", "9호선", ["서울 지하철 9호선"]),
    ("경의중앙선", "경의중앙선", ["경의·중앙선", "수도권 전철 경의·중앙선"]),
    ("수인분당선", "수인분당선", ["수인·분당선"]),
    ("신분당선", "신분당선", []),
    ("공항철도", "공항철도", ["인천국제공항철도"]),
    ("GTX-A", "GTX-A", ["수도권 광역급행철도 A선", "수도권광역급행철도에이선"]),
    ("경춘선", "경춘선", ["수도권 전철 경춘선"]),
    ("경강선", "경강선", ["수도권 전철 경강선"]),
    ("서해선", "서해선", ["수도권 전철 서해선"]),
    ("신림선", "신림선", ["서울 경전철 신림선"]),
    ("우이신설선", "우이신설선", []),
    ("김포골드라인", "김포골드라인", ["김포 골드라인"]),
    ("용인경전철", "용인경전철", ["용인 경전철"]),
    ("의정부경전철", "의정부경전철", []),
    ("인천 1호선", "인천 1호선", ["인천 도시철도 1호선"]),
    ("인천 2호선", "인천 2호선", ["인천 도시철도 2호선"]),
    ("인천공항 자기부상철도", "자기부상철도", []),
    ("인천공항 셔틀트레인", "셔틀트레인", ["인천국제공항트레인"]),
    ("월미바다열차", "월미바다열차", []),
    ("부산 1호선", "부산 1호선", ["부산 도시철도 1호선"]),
    ("부산 2호선", "부산 2호선", ["부산 도시철도 2호선"]),
    ("부산 3호선", "부산 3호선", ["부산 도시철도 3호선"]),
    ("부산 4호선", "부산 4호선", ["부산 도시철도 4호선"]),
    ("부산김해경전철", "부산김해경전철", []),
    ("동해선 광역전철", "동해선", []),
    ("대구 1호선", "대구 1호선", ["대구 도시철도 1호선", "안심~하양 복선전철"]),
    ("대구 2호선", "대구 2호선", ["대구 도시철도 2호선"]),
    ("대구 3호선", "대구 3호선", ["대구 도시철도 3호선"]),
    ("대경선", "대경선", []),
    ("대전 1호선", "대전 1호선", ["대전 도시철도 1호선"]),
    ("광주 1호선", "광주 1호선", ["광주 도시철도 1호선"]),
    ("광주 2호선", "광주 2호선", ["광주 도시철도 2호선"]),
]
LINE_ALIAS = {alias: canon for canon, _, aliases in LINE_TABLE for alias in [canon] + aliases}
LINE_SHORT = {canon: short for canon, short, _ in LINE_TABLE}

# 노선 relation에 들지 않은 선로(way)의 노선을 선 이름으로 정하는 표. 이 선을 다니는 노선이 하나뿐인 경우만 넣는다.
# (예: 서울역 공항철도 승강장 부근의 '인천국제공항선' way 몇 개는 relation에 빠져 있다.)
# 표에 없으면 선 이름을 그대로 노선 이름으로 쓴다(경부선처럼 도시철도가 아닌 선로).
TRACK_SERVICE = {
    "인천국제공항선": "공항철도", "일산선": "3호선", "경인선": "1호선", "수인선": "수인분당선",
    "진접선": "4호선", "별내선": "8호선", "성수지선": "2호선 성수지선", "신정지선": "2호선 신정지선",
}


def track_name(name):
    """선로(way) 이름을 선 이름으로 가볍게 정리한다: 앞뒤 공백 제거, 'X본선' → 'X선'(예: 경부본선 → 경부선),
    노선을 가리키는 이름은 정식 노선 이름으로(예: '서울 지하철 1호선' → '1호선', '부산 도시철도 1호선' → '부산 1호선')."""
    s = (name or "").strip()
    m = re.fullmatch(r"(.{2,})본선", s)
    if m:
        s = m.group(1) + "선"
    return LINE_ALIAS.get(s, s)


def clean_line_name(name):
    """노선 relation 이름을 정식 노선 이름으로: '서울 지하철 9호선 급행: 개화 → …' → '9호선'."""
    s = re.split(r"\s*:\s*", name)[0]
    s = re.sub(r"\s*\(.*?\)", "", s)
    for suffix in (" 급행", " 셔틀", " 일반열차", " 직통열차", " 내선순환", " 외선순환", " 경인·경원 계통"):
        s = s.replace(suffix, "")
    return LINE_ALIAS.get(s.strip(), s.strip())


def metro_routes(routes):
    """도시철도·광역전철 노선 relation만 고른다. KTX·무궁화 같은 열차 운행 계통은 뺀다."""
    out = []
    for r in routes:
        t = r.get("tags", {})
        metro = t.get("route") in ("subway", "light_rail", "monorail")
        commuter = t.get("route") == "train" and (t.get("service") in ("commuter", "commute") or t.get("network") == "수도권 전철")
        if (metro or commuter) and t.get("name"):
            out.append(r)
    return out


def way_line_names(routes):
    """way ID → 그 선로를 지나는 노선의 정식 이름 집합."""
    out = defaultdict(set)
    for r in metro_routes(routes):
        line = clean_line_name(r["tags"]["name"])
        for m in r["members"]:
            if m["type"] == "way":
                out[m["ref"]].add(line)
    return out


def route_direction(r, last_name):
    """노선 relation 하나의 방면 표시: 순환선은 '내선순환'/'외선순환', 나머지는 '<마지막 정차역> 방면'."""
    for word in ("내선순환", "외선순환"):
        if word in r["tags"]["name"]:
            return word
    return f"{last_name} 방면"


def build_line_routes(routes, station_index_of_node, station_out):
    """노선 relation마다 정차역 순서(역 번호 목록)와 방면을 만든다. 길 안내에서 '오금 방면' 같은 종착역 방면을 찾는 데 쓴다.
    station_index_of_node: 정차 위치·역 OSM 노드 ID → 역 번호(stations 배열 위치)."""
    out, seen = [], set()
    for r in metro_routes(routes):
        st = []
        for m in r["members"]:
            if m["type"] == "node" and m.get("role", "").startswith("stop"):
                si = station_index_of_node.get(m["ref"])
                if si is not None and (not st or st[-1] != si):
                    st.append(si)
        if len(st) < 2:
            continue
        loop = st[0] == st[-1]
        name = route_direction(r, station_out[st[-1]]["name"])
        if loop and name.endswith(" 방면"):  # 순환인데 내선·외선 표시가 없으면 방면을 정할 수 없다
            continue
        key = (clean_line_name(r["tags"]["name"]), name, tuple(st))
        if key not in seen:
            seen.add(key)
            out.append({"line": key[0], "dir": name, "loop": 1 if loop else 0, "st": st})
    return out


# ---------- 1. 선로 읽기 ----------

def classify(tags):
    t, b = tags.get("tunnel"), tags.get("bridge")
    if t and t != "no":
        return "tunnel"
    if b and b != "no":
        return "bridge"
    return "ground"  # layer<0, covered=yes도 지상으로 둔다


def load_tracks(route_lines):
    """ways_kr.json을 읽어 그래프용 선로 목록과 노드 좌표 사전을 만든다.
    선로 속성 attr = (구조, 철도 종류, 측선 종류, 노선 이름들, 지역, 선 이름).
    노선 이름: 노선 relation에서 가져오고, relation이 없으면 선 이름으로 정한다(TRACK_SERVICE 표, 없으면 선 이름 그대로)."""
    tracks, coord = [], {}
    for w in load_json(WAYS):
        if w["region"] in EXCLUDED_REGIONS:
            continue
        tags = w["tags"]
        tn = track_name(tags.get("name"))
        lines = sorted(route_lines.get(w["id"], ())) or ([TRACK_SERVICE.get(tn, tn)] if tn else [])
        service = tags.get("service") if tags.get("service") in SERVICE_SIDE else ""
        tracks.append({
            "id": w["id"], "nodes": list(w["nodes"]),
            "attr": (classify(tags), w["railway"], service, tuple(lines), w["region"], tn),
        })
        for n, p in zip(w["nodes"], w["geom"]):
            coord[n] = (p[0], p[1])
    return tracks, coord


class SegmentGrid:
    """선로 선분을 격자(약 220m 칸)에 넣어 '이 점 근처의 선분'을 빨리 찾는다."""
    CELL = 0.002

    def __init__(self, tracks, coord, main_only):
        self.cells = defaultdict(list)
        for ti, t in enumerate(tracks):
            if main_only and t["attr"][2]:
                continue
            for si, (a, b) in enumerate(zip(t["nodes"], t["nodes"][1:])):
                pa, pb = coord[a], coord[b]
                for cy in range(self._c(min(pa[0], pb[0])), self._c(max(pa[0], pb[0])) + 1):
                    for cx in range(self._c(min(pa[1], pb[1])), self._c(max(pa[1], pb[1])) + 1):
                        self.cells[(cy, cx)].append((ti, si))

    def _c(self, v):
        return int(math.floor(v / self.CELL))

    def near(self, p, radius_m):
        r = int(radius_m / 180) + 1  # 칸 수(경도 방향 칸이 위도 방향보다 좁으므로 넉넉히)
        cy, cx = self._c(p[0]), self._c(p[1])
        seen = set()
        for y in range(cy - r, cy + r + 1):
            for x in range(cx - r, cx + r + 1):
                for item in self.cells.get((y, x), ()):
                    if item not in seen:
                        seen.add(item)
                        yield item


def nearest_on_tracks(p, grid, tracks, coord, radius_m):
    """점 p에서 반경 안의 선로마다 가장 가까운 점: {선로번호: (거리, 선분번호, t, (lat, lon))}."""
    best = {}
    for ti, si in grid.near(p, radius_m):
        a, b = coord[tracks[ti]["nodes"][si]], coord[tracks[ti]["nodes"][si + 1]]
        (x1, y1), (x2, y2) = to_xy(a, p), to_xy(b, p)
        dx, dy = x2 - x1, y2 - y1
        seg2 = dx * dx + dy * dy
        t = 0 if seg2 == 0 else max(0, min(1, -(x1 * dx + y1 * dy) / seg2))
        d = math.hypot(x1 + t * dx, y1 + t * dy)
        if d <= radius_m and (ti not in best or d < best[ti][0]):
            best[ti] = (d, si, t, (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    return best


class Snapper:
    """선로 위의 한 점에 부착점을 만든다. 기존 노드와 1m 안이면 그 노드를 쓰고, 아니면 새 노드를 끼워 넣는다."""

    def __init__(self, tracks, coord):
        self.tracks, self.coord = tracks, coord
        self.inserts = defaultdict(list)  # 선로번호 → [(선분번호, t, 새 노드 ID)]
        self.next_id = -1

    def attach(self, ti, si, t, p):
        nodes = self.tracks[ti]["nodes"]
        a, b = self.coord[nodes[si]], self.coord[nodes[si + 1]]
        seg = haversine_m(a, b)
        if t * seg < 1:
            return nodes[si]
        if (1 - t) * seg < 1:
            return nodes[si + 1]
        for si2, t2, nid in self.inserts[ti]:  # 같은 자리에 이미 끼워 넣은 점
            if si2 == si and abs(t2 - t) * seg < 1:
                return nid
        nid, self.next_id = self.next_id, self.next_id - 1
        self.coord[nid] = p
        self.inserts[ti].append((si, t, nid))
        return nid

    def apply(self):
        """모아 둔 새 노드를 선로 노드 목록에 끼워 넣는다."""
        for ti, ins in self.inserts.items():
            by_seg = defaultdict(list)
            for si, t, nid in ins:
                by_seg[si].append((t, nid))
            old, new = self.tracks[ti]["nodes"], []
            for i, n in enumerate(old):
                new.append(n)
                new += [nid for _, nid in sorted(by_seg.get(i, ()))]
            self.tracks[ti]["nodes"] = new


# ---------- 2. 역 묶기와 부착 ----------

def load_stations():
    """역 노드(철도역·지하철역)를 읽는다. 공사중·제주·서비스역은 뺀다."""
    out, skipped = [], Counter()
    for e in load_json(STATIONS)["elements"]:
        t = e.get("tags", {})
        if t.get("railway") in ("construction", "service_station"):
            skipped[t.get("railway")] += 1
            continue
        if "construction:railway" in t and "railway" not in t:  # 공사중 역(railway 태그 없이 표시됨)
            skipped["construction:railway"] += 1
            continue
        lat, lon = (e["lat"], e["lon"]) if "lat" in e else (e["center"]["lat"], e["center"]["lon"])
        if lat < 33.7:  # 제주
            skipped["jeju"] += 1
            continue
        out.append({"osm": f"{e['type'][0]}{e['id']}", "id": e["id"], "type": e["type"], "p": (lat, lon),
                    "name": t.get("name") or t.get("name:ko") or "", "names": name_variants(t)})
    return out, skipped


def group_stations(stations, stop_areas):
    """같은 이름(별칭 포함) 또는 같은 stop_area에 든 역 노드를 500m 안에서 한 그룹(환승역)으로 묶는다."""
    uf = UnionFind(len(stations))
    by_name = defaultdict(list)
    for i, s in enumerate(stations):
        for n in s["names"]:
            by_name[n].append(i)
    for idx in by_name.values():
        for a in idx:
            for b in idx:
                if a < b and haversine_m(stations[a]["p"], stations[b]["p"]) <= GROUP_RADIUS_M:
                    uf.union(a, b)
    node_station = {s["id"]: i for i, s in enumerate(stations) if s["type"] == "node"}
    for members in stop_areas:
        idx = [node_station[m] for m in members if m in node_station]
        for a in idx[1:]:
            if haversine_m(stations[a]["p"], stations[idx[0]]["p"]) <= GROUP_RADIUS_M:
                uf.union(a, idx[0])
    groups = defaultdict(list)
    for i in range(len(stations)):
        groups[uf.find(i)].append(i)
    return list(groups.values())


def assign_stops(stops, stop_areas, stations, station_group):
    """정차 위치 → 역 그룹. stop_area로 먼저 찾고, 없으면 이름이 같은 300m 안의 역."""
    node_station = {s["id"]: i for i, s in enumerate(stations) if s["type"] == "node"}
    area_group = {}
    for members in stop_areas:
        gs = {station_group[node_station[m]] for m in members if m in node_station}
        if len(gs) == 1:
            g = gs.pop()
            for m in members:
                area_group[m] = g
    by_name = defaultdict(list)
    for i, s in enumerate(stations):
        for n in s["names"]:
            by_name[n].append(i)
    out = {}
    for st in stops:
        if st["id"] in area_group:
            out[st["id"]] = area_group[st["id"]]
            continue
        cands = [(haversine_m(st["p"], stations[i]["p"]), i) for n in st["names"] for i in by_name.get(n, ())]
        cands = [c for c in cands if c[0] <= 300]
        if cands:
            out[st["id"]] = station_group[min(cands)[1]]
    return out


def attach_stations(stations, groups, stops, stop_group, tracks, coord):
    """역 그룹마다 선로 위 부착점(노드 ID)을 정한다. 결과: 그룹번호 → {노드 ID: 방법}."""
    snapper = Snapper(tracks, coord)
    grid_all = SegmentGrid(tracks, coord, main_only=False)
    grid_main = SegmentGrid(tracks, coord, main_only=True)
    att = defaultdict(dict)
    stop_points = defaultdict(list)  # 그룹번호 → 정차 위치 좌표(역 노드 근처 확인용)
    for st in stops:
        g = stop_group.get(st["id"])
        if g is None:
            continue
        if st["id"] in coord:                 # (a) 선로 위 노드인 정차 위치
            att[g][st["id"]] = "stop"
        else:                                  # 선로 밖에 찍힌 정차 위치는 30m 안 선로에 붙인다
            near = nearest_on_tracks(st["p"], grid_all, tracks, coord, STOP_SNAP_M)
            if not near:
                continue
            ti, (d, si, t, p) = min(near.items(), key=lambda kv: kv[1][0])
            att[g][snapper.attach(ti, si, t, p)] = "stop"
        stop_points[g].append(st["p"])
    for g, members in enumerate(groups):      # (b) 정차 위치가 없는 역 노드: 가까운 본선 선로에 붙인다
        for i in members:
            p = stations[i]["p"]
            if any(haversine_m(p, q) <= 300 for q in stop_points[g]):
                continue
            near = nearest_on_tracks(p, grid_main, tracks, coord, SNAP_RADIUS_M)
            if not near:
                continue
            t0 = min(near, key=lambda ti: near[ti][0])
            d0, struct0 = near[t0][0], tracks[t0]["attr"][0]
            for ti, (d, si, t, q) in near.items():
                # 가장 가까운 선로와 구조가 같은 선로만 함께 붙인다. 지상역이 그 밑을 지나는
                # 다른 노선의 터널(예: 부산 범일 밑의 경부고속선)에 붙는 것을 막는다.
                if d <= d0 + SNAP_EXTRA_M and tracks[ti]["attr"][0] == struct0:
                    att[g].setdefault(snapper.attach(ti, si, t, q), "snap")
    snapper.apply()
    return att


# ---------- 3. 선로를 간선으로 자르고 줄이기 ----------

def split_tracks(tracks, coord, keep_nodes):
    """선로를 끝점·분기점(2개 이상 선로가 공유)·부착점에서 잘라 조각(간선 후보)으로 만든다."""
    use = Counter(n for t in tracks for n in t["nodes"])
    pieces = []
    for t in tracks:
        nodes = t["nodes"]
        start = 0
        for i in range(1, len(nodes)):
            n = nodes[i]
            if i == len(nodes) - 1 or use[n] >= 2 or n in keep_nodes:
                pts = [coord[x] for x in nodes[start:i + 1]]
                length = sum(haversine_m(a, b) for a, b in zip(pts, pts[1:]))
                pieces.append({"a": nodes[start], "b": n, "pts": pts, "len": length, "attr": t["attr"], "way": t["id"]})
                start = i
    return pieces


def contract(edges, n_nodes, keep):
    """차수 2이고 양쪽 간선 속성이 같은 노드를 없애고 두 간선을 하나로 합친다."""
    adj = [[] for _ in range(n_nodes)]
    for ei, e in enumerate(edges):
        adj[e["a"]].append(ei)
        adj[e["b"]].append(ei)
    alive = [True] * len(edges)
    for v in range(n_nodes):
        if keep[v] or len(adj[v]) != 2:
            continue
        e1, e2 = adj[v]
        E1, E2 = edges[e1], edges[e2]
        if e1 == e2 or E1["attr"] != E2["attr"]:
            continue
        p1 = E1["pts"] if E1["b"] == v else E1["pts"][::-1]   # u → v 방향
        u = E1["a"] if E1["b"] == v else E1["b"]
        p2 = E2["pts"] if E2["a"] == v else E2["pts"][::-1]   # v → w 방향
        w = E2["b"] if E2["a"] == v else E2["a"]
        E1.update(a=u, b=w, pts=p1 + p2[1:], len=E1["len"] + E2["len"], ways=E1["ways"] | E2["ways"])
        alive[e2] = False
        adj[w] = [e1 if x == e2 else x for x in adj[w]]
        adj[v] = []
    return [e for e, ok in zip(edges, alive) if ok]


# ---------- 4. 환승·출입구 ----------

def seoul_csv_line(s):
    """서울교통공사 자료의 노선 표기를 정식 노선 이름(LINE_TABLE)으로 바꾼다."""
    s = s.strip()
    if s.endswith("호선") and s[:-2].isdigit():
        s = s[:-2]
    if s.isdigit():
        return s + "호선"
    table = {
        "공항철도": "공항철도", "경의중앙선": "경의중앙선", "수인분당선": "수인분당선",
        "신분당선": "신분당선", "우이신설선": "우이신설선", "신림선": "신림선",
        "김포골드라인": "김포골드라인", "서해선": "서해선", "경춘선": "경춘선",
        "경원선": "1호선",      # 석계: 경원선 = 1호선
        "국철": "수인분당선",   # 수서: 3호선 ↔ 국철(수인분당선으로 봄)
    }
    return table.get(s)


def has_line(lines, label):
    """노선 이름 목록에 label(지선 포함, 예: '2호선' → '2호선 성수지선'도 맞음)이 있는가."""
    return any(l == label or l.startswith(label + " ") for l in lines)


def entrance_station_name(tags):
    """출입구 설명에서 역 이름을 뽑는다: '잠실역7번출구' → '잠실'."""
    for key in ("description:ko", "description", "name:ko", "name"):
        m = re.match(r"\s*(.+?)역", tags.get(key, ""))
        if m:
            return normalize_name(m.group(1))
    return None


def segments_cross(p1, p2, q1, q2):
    (y1, x1), (y2, x2), (y3, x3), (y4, x4) = p1, p2, q1, q2
    d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
    if d == 0:
        return False
    t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
    u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
    return 0 <= t <= 1 and 0 <= u <= 1


# ---------- 본체 ----------

def build_track_graph(tracks, coord, attach_nodes):
    """선로를 잘라 간선으로 만들고, 터널 출입구(갱구)를 표시하고, 차수 2 노드를 합친다."""
    pieces = split_tracks(tracks, coord, attach_nodes)
    node_index = {}
    for pc in pieces:
        for n in (pc["a"], pc["b"]):
            node_index.setdefault(n, len(node_index))
    node_ids = list(node_index)
    edges = [{"a": node_index[pc["a"]], "b": node_index[pc["b"]], "pts": pc["pts"], "len": pc["len"],
              "attr": pc["attr"], "ways": {pc["way"]}} for pc in pieces]
    struct_at = defaultdict(set)
    for e in edges:
        struct_at[e["a"]].add(e["attr"][0])
        struct_at[e["b"]].add(e["attr"][0])
    portal = [("tunnel" in struct_at[v] and len(struct_at[v]) > 1) for v in range(len(node_ids))]
    is_att = [node_ids[v] in attach_nodes for v in range(len(node_ids))]
    keep = [p or a for p, a in zip(portal, is_att)]
    merged = contract(edges, len(node_ids), keep)
    print(f"선로 조각 {len(edges)}개 → 합친 뒤 {len(merged)}개")
    # 쓰는 노드만 남기고 번호를 다시 매긴다
    used = sorted({v for e in merged for v in (e["a"], e["b"])})
    renum = {v: i for i, v in enumerate(used)}
    nodes = [{"p": coord[node_ids[v]], "flag": (1 if portal[v] else 0) | (2 if is_att[v] else 0)} for v in used]
    for e in merged:
        e["a"], e["b"] = renum[e["a"]], renum[e["b"]]
    osm_to_node = {node_ids[v]: renum[v] for v in used}
    return nodes, merged, osm_to_node


def build_stations(stations, groups, att, nodes, edges, osm_to_node):
    """역 그룹마다 부착점 정보(노선, 지하 여부)를 모으고, 노선별 '승강장 허브' 노드를 만든다.
    부착점 ↔ 허브: 승강장 간선(직선 거리). 같은 노선의 상·하행 선로는 허브를 거쳐 오간다."""
    node_edges = defaultdict(list)
    for e in edges:
        node_edges[e["a"]].append(e)
        node_edges[e["b"]].append(e)

    def att_info(v):
        es = node_edges[v]
        main = [e for e in es if not e["attr"][2]] or es
        return {"node": v, "lines": sorted({l for e in es for l in e["attr"][3]}),
                "ug": all(e["attr"][0] == "tunnel" for e in main),  # 붙은 본선이 모두 터널이면 지하
                "region": Counter(e["attr"][4] for e in es).most_common(1)[0][0]}

    out, unattached, platform_edges = [], [], []
    for g, members in enumerate(groups):
        names = Counter(stations[i]["name"] for i in members)
        name = max(names, key=lambda n: (names[n], -len(n)))
        p = (sum(stations[i]["p"][0] for i in members) / len(members), sum(stations[i]["p"][1] for i in members) / len(members))
        osm = [stations[i]["osm"] for i in members]
        atts = [att_info(osm_to_node[n]) for n in att.get(g, {}) if n in osm_to_node]
        if not atts:
            unattached.append({"name": name, "osm": osm, "lat": round(p[0], 5), "lon": round(p[1], 5)})
            continue
        s = {"name": name, "names": sorted(set().union(*(stations[i]["names"] for i in members))), "p": p, "osm": osm,
             "group": g,
             "atts": atts, "region": Counter(a["region"] for a in atts).most_common(1)[0][0],
             "methods": Counter(att[g].values()), "hubs": []}
        by_lines = defaultdict(list)
        for a in atts:
            by_lines[tuple(a["lines"])].append(a)
        for lines, group_atts in by_lines.items():
            hp = (sum(nodes[a["node"]]["p"][0] for a in group_atts) / len(group_atts),
                  sum(nodes[a["node"]]["p"][1] for a in group_atts) / len(group_atts))
            v = len(nodes)
            nodes.append({"p": hp, "flag": 8})
            s["hubs"].append({"node": v, "lines": list(lines), "ug": any(a["ug"] for a in group_atts), "atts": group_atts})
            for a in group_atts:
                platform_edges.append({"a": a["node"], "b": v, "len": haversine_m(nodes[a["node"]]["p"], hp),
                                       "struct": "underground" if a["ug"] else "ground", "region": s["region"]})
        out.append(s)
    print(f"부착된 역 그룹 {len(out)}개, 부착 못 한 역 그룹 {len(unattached)}개")
    return out, unattached, platform_edges


def build_transfers(station_out, nodes):
    """같은 역 그룹 안의 허브끼리 환승 간선을 만든다. 서울교통공사 자료가 있으면 그 거리로 바꾼다."""
    transfers = {}
    for s in station_out:
        for i, x in enumerate(s["hubs"]):
            for y in s["hubs"][i + 1:]:
                d = haversine_m(nodes[x["node"]]["p"], nodes[y["node"]]["p"])
                if d <= GROUP_RADIUS_M + 100:
                    transfers[(x["node"], y["node"])] = {"a": x["node"], "b": y["node"], "len": est_transfer_m(d),
                                                         "src": "estimated", "ug": x["ug"] and y["ug"], "region": s["region"]}
    result = {"rows": 0, "matched": 0, "unmatched": [], "edges_set": 0, "conflicts": []}
    name_to_station = defaultdict(list)
    for s in station_out:
        if s["region"] in ("서울특별시", "경기도", "인천광역시"):
            for n in s["names"]:
                name_to_station[n].append(s)
    for row in read_cp949_csv(SEOUL_TRANSFER):
        result["rows"] += 1
        from_l, to_l, dist = seoul_csv_line(row[1]), seoul_csv_line(row[3]), float(row[4])
        hit = False
        for s in name_to_station.get(normalize_name(row[2]), ()):
            for x in s["hubs"]:
                for y in s["hubs"]:
                    key = (x["node"], y["node"]) if (x["node"], y["node"]) in transfers else (y["node"], x["node"])
                    if x is y or key not in transfers or not (has_line(x["lines"], from_l) and has_line(y["lines"], to_l)):
                        continue
                    t, hit = transfers[key], True
                    if t["src"] == "seoul_metro" and t["len"] != dist:
                        result["conflicts"].append(f"{row[2]} {row[1]}↔{row[3]}: {t['len']} vs {dist}")
                    elif t["src"] != "seoul_metro":
                        t.update(len=dist, src="seoul_metro")
                        result["edges_set"] += 1
        if hit:
            result["matched"] += 1
        else:
            result["unmatched"].append(f"{row[1]}호선 {row[2]} → {row[3]}")
    print(f"서울교통공사 환승 자료 {result['rows']}행 중 {result['matched']}행 반영, 간선 {result['edges_set']}개")
    return list(transfers.values()), result


def link_entrances(station_out, nodes):
    """출입구마다 300m 안의 역(이름이 맞는 역 우선)을 찾아, 그 역의 가장 가까운 허브(지하 허브 우선)에 잇는다."""
    ent_json = [e for e in load_json(ENTRANCES)["elements"] if e["type"] == "node" and e["lat"] >= 33.7]
    grid = defaultdict(list)
    for si, s in enumerate(station_out):
        grid[(int(s["p"][0] / 0.005), int(s["p"][1] / 0.005))].append(si)
    edges, out, stats = [], [], Counter()
    for e in ent_json:
        p, tags = (e["lat"], e["lon"]), e.get("tags", {})
        cy, cx = int(p[0] / 0.005), int(p[1] / 0.005)
        cands = []
        for y in range(cy - 1, cy + 2):
            for x in range(cx - 1, cx + 2):
                for si in grid.get((y, x), ()):
                    s = station_out[si]
                    d = min([haversine_m(p, s["p"])] + [haversine_m(p, nodes[h["node"]]["p"]) for h in s["hubs"]])
                    if d <= ENTRANCE_RADIUS_M:
                        cands.append((d, si))
        if not cands:
            stats["no_station"] += 1
            continue
        nm = entrance_station_name(tags)
        named = [c for c in cands if nm and nm in station_out[c[1]]["names"]]
        d, si = min(named or cands)
        stats["name_match" if named else "nearest"] += 1
        hubs = station_out[si]["hubs"]
        hub = min([h for h in hubs if h["ug"]] or hubs, key=lambda h: haversine_m(p, nodes[h["node"]]["p"]))
        v = len(nodes)
        nodes.append({"p": p, "flag": 4})
        edges.append({"a": v, "b": hub["node"], "len": haversine_m(p, nodes[hub["node"]]["p"]),
                      "struct": "entrance" if hub["ug"] else "ground", "region": station_out[si]["region"]})
        out.append({"node": v, "station": si, "ref": tags.get("ref", "")})
    stats["total"] = len(ent_json)
    print(f"출입구 {len(ent_json)}개: {dict(stats)}")
    return edges, out, dict(stats)


def han_crossing(pts, river, box):
    """선 pts가 한강 중심선과 교차하는가(평면 근사)."""
    if max(p[0] for p in pts) < box[0] or min(p[0] for p in pts) > box[2] or \
       max(p[1] for p in pts) < box[1] or min(p[1] for p in pts) > box[3]:
        return False
    return any(segments_cross(p1, p2, q1, q2) for p1, p2 in zip(pts, pts[1:]) for q1, q2 in zip(river, river[1:]))


def write_graph(nodes, edges, platform_edges, transfers, entrance_edges, station_out, entrance_out, line_routes, depths):
    """압축 JSON을 만든다. 간선은 열(column)별 배열, 선 모양은 인코딩 폴리라인.
    depths: 역 번호 → 깊이 기록 목록(station_depths). 기록이 있는 역에만 stations[].depth를 넣는다."""
    regions = sorted({e["attr"][4] for e in edges})
    region_idx = {r: i for i, r in enumerate(regions)}
    line_names = sorted({l for e in edges for l in e["attr"][3]})
    line_idx = {l: i for i, l in enumerate(line_names)}
    track_names = [""] + sorted({e["attr"][5] for e in edges} - {""})  # 0번 = 이름 없음
    track_idx = {n: i for i, n in enumerate(track_names)}
    line_sets, line_set_idx = [], {}

    def ls_index(lines):
        key = tuple(sorted(line_idx[l] for l in lines))
        if key not in line_set_idx:
            line_set_idx[key] = len(line_sets)
            line_sets.append(list(key))
        return line_set_idx[key]

    ls_index(())
    cols = {k: [] for k in ("a", "b", "len", "s", "k", "r", "svc", "ls", "rg", "src", "g", "tn")}

    def add(a, b, length, struct, kind, region, railway="", service="", lines=(), src="", pts=None, tn=""):
        for k, v in (("a", a), ("b", b), ("len", round(length, 1)), ("s", STRUCTS.index(struct)),
                     ("k", KINDS.index(kind)), ("r", RAILWAYS.index(railway) if railway else -1),
                     ("svc", SERVICES.index(service)), ("ls", ls_index(lines)), ("rg", region_idx[region]),
                     ("src", SOURCES.index(src)), ("g", encode_polyline(pts) if pts else ""), ("tn", track_idx[tn])):
            cols[k].append(v)

    river = [[(p["lat"], p["lon"]) for p in e["geometry"]] for e in load_json(HAN_RIVER)["elements"] if e["type"] == "way"][0]
    box = (min(p[0] for p in river), min(p[1] for p in river), max(p[0] for p in river), max(p[1] for p in river))
    han = []
    for e in edges:
        struct, railway, service, lines, region, tn = e["attr"]
        pts = douglas_peucker(e["pts"], DP_TOLERANCE_M)
        if han_crossing(pts, river, box):
            han.append({"e": len(cols["a"]), "s": struct, "lines": list(lines), "ways": sorted(e["ways"])})
        add(e["a"], e["b"], e["len"], struct, "track", region, railway, service, lines, "", pts, tn)
    for t in platform_edges:
        add(t["a"], t["b"], t["len"], t["struct"], "platform", t["region"])
    for t in transfers:
        add(t["a"], t["b"], t["len"], "underground" if t["ug"] else "ground", "transfer", t["region"], src=t["src"])
    for t in entrance_edges:
        add(t["a"], t["b"], t["len"], t["struct"], "entrance", t["region"])

    stations_json = []
    for si, s in enumerate(station_out):
        st = {"name": s["name"], "names": s["names"], "lat": round(s["p"][0] * 1e5), "lon": round(s["p"][1] * 1e5),
              "rg": region_idx[s["region"]], "hubs": [h["node"] for h in s["hubs"]],
              "hub_ls": [ls_index(h["lines"]) for h in s["hubs"]], "ug": [1 if h["ug"] else 0 for h in s["hubs"]],
              "plat": [a["node"] for a in s["atts"]]}
        if depths.get(si):  # 서울교통공사 역 깊이 자료가 있는 역만
            st["depth"] = [{"line": line_idx[d["line"]], "floor": d["floor"], "platform_m": d["platform_m"],
                            "track_m": d["track_m"]} for d in depths[si]]
        stations_json.append(st)

    graph = {
        "format": "underground-route-graph", "version": 1,
        "attribution": ["© OpenStreetMap contributors (ODbL)",
                        "서울교통공사 환승역 환승거리(2025-03-31)·역 깊이(1~8호선 2024-11-04, 9호선 2·3단계 2026-01-31), 서울 열린데이터광장, 공공누리 제1유형"],
        "osm_base": "2026-11-10",
        "weights": {"under": 1, "exposed": 1000},
        "tables": {"structs": STRUCTS, "under_structs": sorted(UNDER_STRUCTS), "kinds": KINDS, "sources": SOURCES,
                   "railways": RAILWAYS, "services": SERVICES, "lines": line_names, "line_sets": line_sets,
                   "regions": [{"name": r, "conf": CONFIDENCE.get(r, "unchecked")} for r in regions],
                   "line_short": [LINE_SHORT.get(l, l) for l in line_names],
                   "line_metro": [1 if l in LINE_SHORT else 0 for l in line_names], "track_names": track_names},
        "nodes": {"lat": [round(n["p"][0] * 1e5) for n in nodes], "lon": [round(n["p"][1] * 1e5) for n in nodes],
                  "f": [n["flag"] for n in nodes]},
        "edges": cols,
        "stations": stations_json,
        "entrances": {"node": [x["node"] for x in entrance_out], "station": [x["station"] for x in entrance_out],
                      "ref": [x["ref"] for x in entrance_out]},
        "presets": {"han_crossings": [{"e": h["e"], "s": h["s"], "lines": h["lines"]} for h in han]},
        "line_routes": [{"l": line_idx[r["line"]], "dir": r["dir"], "loop": r["loop"], "st": r["st"]}
                        for r in line_routes if r["line"] in line_idx],
    }
    os.makedirs(os.path.dirname(OUT_GRAPH), exist_ok=True)
    with open(OUT_GRAPH, "w", encoding="utf-8") as f:
        json.dump(graph, f, ensure_ascii=False, separators=(",", ":"))
    return graph, han


def main():
    routes = [e for e in load_json(ROUTES)["elements"] if e["type"] == "relation"]
    tracks, coord = load_tracks(way_line_names(routes))
    print(f"선로 way {len(tracks)}개 (제주 제외)")

    # 역·정차 위치·stop_area → 역 그룹과 선로 부착점
    stations, skipped = load_stations()
    stop_json = load_json(STOPS)["elements"]
    stops = [{"id": e["id"], "p": (e["lat"], e["lon"]), "names": name_variants(e.get("tags", {}))}
             for e in stop_json if e["type"] == "node" and e["lat"] >= 33.7]
    stop_areas = [[m["ref"] for m in e["members"] if m["type"] == "node"] for e in stop_json if e["type"] == "relation"]
    groups = group_stations(stations, stop_areas)
    station_group = {i: g for g, members in enumerate(groups) for i in members}
    stop_group = assign_stops(stops, stop_areas, stations, station_group)
    att = attach_stations(stations, groups, stops, stop_group, tracks, coord)
    print(f"역 노드 {len(stations)}개 → 역 그룹 {len(groups)}개, 정차 위치 {len(stops)}개 중 역에 연결 {len(stop_group)}개")

    nodes, edges, osm_to_node = build_track_graph(tracks, coord, {n for a in att.values() for n in a})
    station_out, unattached, platform_edges = build_stations(stations, groups, att, nodes, edges, osm_to_node)
    transfers, csv_result = build_transfers(station_out, nodes)
    entrance_edges, entrance_out, ent_stats = link_entrances(station_out, nodes)

    # 노선 relation의 정차 순서(종착역 방면 안내용): 정차 위치·역 노드 → 역 번호
    out_of_group = {s["group"]: i for i, s in enumerate(station_out)}
    node_group = {s["id"]: station_group[i] for i, s in enumerate(stations) if s["type"] == "node"}
    node_group.update(stop_group)
    station_index_of_node = {n: out_of_group[g] for n, g in node_group.items() if g in out_of_group}
    line_routes = build_line_routes(routes, station_index_of_node, station_out)
    print(f"노선 relation 정차 순서 {len(line_routes)}개")
    depth_rows = match_depth_rows(station_out)
    depths = station_depths(depth_rows)
    print(f"서울교통공사 역 깊이 자료 {len(depth_rows)}행 중 {sum(1 for r in depth_rows if r[2])}행을 역 {len(depths)}개에 반영")
    graph, han = write_graph(nodes, edges, platform_edges, transfers, entrance_edges, station_out, entrance_out, line_routes,
                             depths)

    # ---------- 점검 결과 ----------
    report = stats(graph, len(edges))
    report["stations"] = {
        "osm_station_nodes": len(stations), "skipped": dict(skipped), "groups": len(groups),
        "stops": len(stops), "stops_linked_to_station": len(stop_group),
        "attached": len(station_out), "unattached": len(unattached),
        "attach_points_by_method": dict(sum((s["methods"] for s in station_out), Counter())),
        "all_underground": sum(all(a["ug"] for a in s["atts"]) for s in station_out),
        "partly_underground": sum(any(a["ug"] for a in s["atts"]) and not all(a["ug"] for a in s["atts"]) for s in station_out),
        "unattached_list": unattached,
    }
    report["seoul_transfer_csv"] = csv_result
    report["entrances"] = ent_stats
    report["seoul_depth_check"] = depth_check(depth_rows)
    report["han_crossings"] = han
    report["names"] = name_stats(graph)
    with open(OUT_REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    size = os.path.getsize(OUT_GRAPH)
    print(f"저장: {OUT_GRAPH} {size:,} bytes, 노드 {report['nodes']:,}, 간선 {report['edges']:,}. 점검 결과: {OUT_REPORT}")


def stats(graph, n_track):
    """그래프 통계: 노드·간선 수, 구조별 선로 km, 연결 요소 수."""
    E, tb = graph["edges"], graph["tables"]
    km = defaultdict(float)
    for i in range(n_track):
        km[("service" if E["svc"][i] else "main") + ":" + tb["structs"][E["s"][i]]] += E["len"][i] / 1000
    n = len(graph["nodes"]["f"])

    def components(pred):
        uf = UnionFind(n)
        idx = [i for i in range(len(E["a"])) if pred(i)]
        for i in idx:
            uf.union(E["a"][i], E["b"][i])
        sizes = defaultdict(float)
        for i in idx:
            sizes[uf.find(E["a"][i])] += E["len"][i] / 1000
        top = sorted(sizes.values(), reverse=True)
        return {"components": len(sizes), "largest_km": [round(x, 1) for x in top[:5]]}

    under = {tb["structs"].index(s) for s in tb["under_structs"]}
    tunnel, track = tb["structs"].index("tunnel"), tb["kinds"].index("track")
    return {
        "nodes": n, "edges": len(E["a"]),
        "edges_by_kind": dict(Counter(tb["kinds"][k] for k in E["k"])),
        "transfers_by_source": dict(Counter(tb["sources"][E["src"][i]] + ":" + tb["structs"][E["s"][i]]
                                            for i in range(len(E["a"])) if tb["kinds"][E["k"][i]] == "transfer")),
        "track_km": {k: round(v, 1) for k, v in sorted(km.items())},
        "components_all": components(lambda i: True),
        "components_tunnel_tracks": components(lambda i: E["k"][i] == track and E["s"][i] == tunnel),
        "components_underground_walk": components(lambda i: E["s"][i] in under),
    }


def name_stats(graph):
    """노선·선 이름 점검: 노선 수, 짧은 이름이 다른 노선, 본선 선로 길이가 긴 선 이름 30개."""
    E, tb = graph["edges"], graph["tables"]
    km = Counter()
    for i in range(len(E["a"])):
        if tb["kinds"][E["k"][i]] == "track" and not E["svc"][i]:
            km[tb["track_names"][E["tn"][i]]] += E["len"][i] / 1000
    return {
        "lines": len(tb["lines"]), "track_names": len(tb["track_names"]) - 1,
        "short_differs": {l: s for l, s in zip(tb["lines"], tb["line_short"]) if l != s},
        "line_routes": len(graph["line_routes"]),
        "top_track_names_km": [[n or "(이름 없음)", round(v, 1)] for n, v in km.most_common(30)],
    }


DEPTH_ALIASES = {  # 역 깊이 자료(2024)의 옛 이름·줄임말 → 현재 OSM 이름
    "을지3가": "을지로3가", "을지4가": "을지로4가", "구로디지털": "구로디지털단지", "당고개": "불암산",
    "미아삼거리": "미아사거리", "애오게": "애오개", "동대문운동장": "동대문역사문화공원", "둔촌": "둔촌동",
    "DMC": "디지털미디어시티", "뚝섬유원지": "자양", "숭실대": "숭실대입구", "신대방": "신대방삼거리",
    "광명": "광명사거리",
}


def match_depth_rows(station_out):
    """서울교통공사 역 깊이 자료의 행마다 맞는 (역 번호, 부착점) 목록을 찾는다.
    결과: [(행, 노선 이름, [(stations 번호, 부착점), ...])]. 서울·경기 역에서 이름(원래 이름 먼저, 없으면 DEPTH_ALIASES의
    바뀐 이름)이 같고, 부착점의 노선이 자료의 호선(지선 포함, has_line)인 것을 고른다."""
    by_name = defaultdict(list)
    for si, s in enumerate(station_out):
        if s["region"] in ("서울특별시", "경기도"):
            for n in s["names"]:
                by_name[n].append(si)
    out = []
    for row in (r for path in SEOUL_DEPTH for r in read_cp949_csv(path)):
        line = seoul_csv_line(row[1])
        hits = []
        for name in (row[2], DEPTH_ALIASES.get(row[2].strip(), "")):  # 원래 이름 먼저, 없으면 바뀐 이름
            hits = hits or [(si, a) for si in by_name.get(normalize_name(name), ())
                            for a in station_out[si]["atts"] if has_line(a["lines"], line)]
        out.append((row, line, hits))
    return out


def station_depths(depth_rows):
    """역 번호 → 깊이 기록 목록(자료 순서). 기록: {"line": 노선 이름, "floor": 층수 글자 그대로,
    "platform_m": 정거장깊이, "track_m": 선로기준정거장깊이}. 노선 이름은 그 역 부착점의 노선 중 자료 호선과 같은 것
    (없으면 지선, 예: 용답 → '2호선 성수지선')이라 stations[].hub_ls의 노선과 맞춰 볼 수 있다."""
    out = defaultdict(list)
    for row, label, hits in depth_rows:
        for si in dict.fromkeys(si for si, _ in hits):
            lines = sorted({l for sj, a in hits if sj == si for l in a["lines"] if has_line([l], label)})
            out[si].append({"line": label if label in lines else lines[0], "floor": row[3].strip(),
                            "platform_m": float(row[8]), "track_m": float(row[7])})
    return out


def depth_check(depth_rows):
    """서울교통공사 역 깊이 자료(B층 = 지하, 고가·지상 = 지상)와 그래프의 승강장 지하 여부를 비교한다."""
    res = {"rows": 0, "agree": 0, "disagree": [], "no_match": []}
    for row, line, hits in depth_rows:
        res["rows"] += 1
        floor = row[3].strip()
        expect_ug = floor.startswith("B")
        got = [a["ug"] for _, a in hits]
        if not got:
            res["no_match"].append(f"{row[1]}호선 {row[2]}")
        elif all(g == expect_ug for g in got):
            res["agree"] += 1
        else:
            res["disagree"].append(f"{row[1]}호선 {row[2]}: 자료 {floor}, 그래프 지하 부착점 {sum(got)}/{len(got)}")
    return res


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
