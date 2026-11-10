# build_egress.py
# 하는 일: 철도 터널망에서 지상으로 나가는 곳 중 '역 출구가 아닌 것'을 모아 web\data\egress.json 을 만든다.
#   1) portal: 선로가 터널에서 교량·지상으로 나오는 곳(graph.json 노드 f의 1). 60m 안의 나란한 선로는 하나로 묶는다.
#   2) shaft / emergency_exit: OSM의 환기구·수직구·비상구 태그(터널 선로 80m 안)를 가장 가까운 터널 간선에 붙인다.
#   3) depot: 차량기지·차량사업소·검수고(OSM landuse=railway·railway=depot 등 이름 있는 곳)와 그 안의 측선 노드,
#      나가는 곳(출입문이 있으면 출입문, 없으면 공공 도로에 가장 가까운 경계 지점 = 근사).
# 사용법(프로젝트 폴더에서):
#   python -I scripts\build_egress.py --fetch   원본이 없으면 Overpass 로 받는다(한 번에 하나씩) → 그리고 만든다
#   python -I scripts\build_egress.py           data\raw\egress\ 의 원본으로 만들기만 한다
# 원본: data\raw\egress\*.json (Overpass 응답 그대로). 그래프는 web\data\graph.json, 선로 way는 data\derived\ways_kr.json 을 읽기만 한다.
# 형식: docs\graph-format.md 의 'egress.json' 절.
# 원칙: Python 표준 라이브러리만 쓴다. Overpass 요청은 scripts\overpass_fetch.py 의 fetch() 를 그대로 쓴다.
import heapq
import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))  # -I 모드에서도 옆 스크립트를 불러오기 위해
from build_graph import haversine_m, to_xy  # noqa: E402

GRAPH = os.path.join(ROOT, "web", "data", "graph.json")
WAYS = os.path.join(ROOT, "data", "derived", "ways_kr.json")
RAW = os.path.join(ROOT, "data", "raw", "egress")
OUT = os.path.join(ROOT, "web", "data", "egress.json")
OUT_REPORT = os.path.join(ROOT, "data", "derived", "egress_report.json")

# ---------- Overpass 쿼리 ----------
RAIL = '^(rail|subway|light_rail|monorail|narrow_gauge)$'
# 이름으로 찾는 환기구·수직구·비상구 낱말
SHAFT_WORDS = "수직구|환기구|환기탑|환기실|환기소|환기시설|배기구|급기구|사갱|작업구"
EXIT_WORDS = "비상구|비상탈출|비상출구|비상계단|피난구|탈출구"
NAME_RE = SHAFT_WORDS + "|" + EXIT_WORDS
# 터널 선로 근처를 볼 사각형(남,서,북,동). docs\data-check.md 의 선로 타일과 같다.
TILES = {"A1": (37.0, 124.5, 37.7, 128.0), "A2": (37.7, 124.5, 38.7, 128.0), "B": (37.0, 128.0, 38.7, 131.0),
         "C": (36.0, 124.5, 37.0, 131.0), "D": (35.0, 124.5, 36.0, 131.0), "E": (33.0, 124.5, 35.0, 131.0)}
NEAR_M = 80  # 터널 선로에서 이 거리 안의 것만 본다
# 전국을 상자 5개로 나눠 받는다(남,서,북,동). 수도권 띠(37.3~38.7)는 세 서버 모두 시간 초과·502라 경도 127.0·127.6도에서 나눴다.
BANDS = [(33.0, 124.5, 36.0, 131.0), (36.0, 124.5, 37.3, 131.0), (37.3, 124.5, 38.7, 127.0),
         (37.3, 127.0, 38.7, 127.6), (37.3, 127.6, 38.7, 131.0)]

QUERIES = [
    (f"near_{k}.json",
     f'[out:json][timeout:300][bbox:{s},{w},{n},{e}];\n'
     f'// 타일 {k}: 터널 선로 {NEAR_M}m 안의 환기구·수직구·비상구 후보(태그를 넓게 받아 개수를 센다)\n'
     f'way[railway~"{RAIL}"][tunnel][tunnel!=no]->.t;\n'
     f'(\n'
     f'  nwr(around.t:{NEAR_M})[man_made~"^(ventilation_shaft|tower|chimney|tunnel_ventilation|shaft)$"];\n'
     f'  nwr(around.t:{NEAR_M})[railway~"^(ventilation_shaft|emergency_exit|escape|shaft)$"];\n'
     f'  nwr(around.t:{NEAR_M})[building~"^(ventilation_shaft|ventilation|shaft)$"];\n'
     f'  nwr(around.t:{NEAR_M})[entrance~"^(emergency|exit)$"];\n'
     f'  nwr(around.t:{NEAR_M})["exit"];\n'
     f'  nwr(around.t:{NEAR_M})[emergency];\n'
     f'  nwr(around.t:{NEAR_M})[highway=steps][tunnel];\n'
     f'  nwr(around.t:{NEAR_M})[highway=steps][level~"^-"];\n'
     f'  nwr(around.t:{NEAR_M})[highway=steps][layer~"^-"];\n'
     f'  nwr(around.t:{NEAR_M})[name~"{NAME_RE}"];\n'
     f');\nout center tags;')
    for k, (s, w, n, e) in TILES.items()
] + [
    # 전국 쿼리(area)는 오래된 대체 서버에서 빈 결과가 온 적이 있어(2026-11-10) 상자 4개(BANDS)로 나눠 받는다.
    (f"named_{i}.json",
     f'[out:json][timeout:600][bbox:{s},{w},{n},{e}];\n'
     f'// 상자 {s},{w},{n},{e}: 환기구·수직구·비상구 태그와 이름(거리 제한 없이 받아 터널과의 거리는 만들 때 잰다)\n'
     '(\n'
     '  nwr[man_made=ventilation_shaft];\n'
     '  nwr[railway~"^(ventilation_shaft|emergency_exit)$"];\n'
     '  nwr[building~"^(ventilation_shaft|ventilation)$"];\n'
     '  nwr[entrance=emergency];\n'
     f'  nwr[name~"{NAME_RE}"];\n'
     ');\nout center tags;')
    for i, (s, w, n, e) in enumerate(BANDS)
] + [
    (f"depots_{i}.json",
     f'[out:json][timeout:600][bbox:{s},{w},{n},{e}];\n'
     f'// 상자 {s},{w},{n},{e}: 철도 용지(landuse=railway), railway=depot·yard·workshop, 이름에 차량기지·차량사업소·검수고 등이 든 것\n'
     '(\n'
     '  wr[landuse=railway];\n'
     '  nwr[railway~"^(depot|yard|workshop|wash|traverser)$"];\n'
     + ('  nwr[name~"차량기지|차량사업소|검수고|검수기지|정비기지|차량정비|주박기지|차량관리단|철도차량"];\n' if i < 2 else '')
     + ');\nout geom tags;')
    # 수도권 상자(2·3)는 이름 정규식 줄을 넣으면 서버가 502·504로 실패해(2026-11-10) 태그 줄만 받는다.
    # 상자 0·1에서 이름 줄로만 더 잡힌 것은 건물(검수고 등)뿐이고, 기지는 landuse=railway 면으로 잡혔다.
    for i, (s, w, n, e) in enumerate(BANDS)
] + [
    ("corridor_srt_gtxa.json",
     '[out:json][timeout:300][bbox:36.9,126.6,37.8,127.3];\n'
     '// 율현터널(수서평택고속선)·GTX-A 터널 선로 200m 안의 시설(수직구가 지도에 있는지 확인용)\n'
     'way[railway~"' + RAIL + '"][tunnel][tunnel!=no][name~"^(수서평택고속선|수도권광역급행철도에이선)$"]->.t;\n'
     '(\n'
     '  nwr(around.t:200)[man_made];\n'
     '  nwr(around.t:200)[building~"^(service|transportation|industrial|ventilation_shaft|ventilation|shaft|construction|hut|shed|yes)$"][name];\n'
     '  nwr(around.t:200)[building~"^(service|transportation|ventilation_shaft|ventilation|shaft|hut|shed)$"];\n'
     '  nwr(around.t:200)[landuse~"^(railway|construction)$"];\n'
     '  nwr(around.t:200)[emergency];\n'
     '  nwr(around.t:200)[entrance][entrance!~"^(yes|main|service|home)$"];\n'
     '  nwr(around.t:200)[name~"수직구|환기|비상|작업구|사갱|율현|GTX"];\n'
     ');\nout center tags;'),
]
ROADS_FILE = "depot_roads.json"  # 차량기지 사각형 안의 도로·출입문(두 번째 단계에서 쿼리를 만든다)


CLIENT_WAIT_S = 400  # 한 서버에서 응답을 기다리는 최대 시간(overpass_fetch 의 900초는 서버가 바쁠 때 너무 길다)


def fetch_one(name, q):
    import urllib.request
    import overpass_fetch
    if not getattr(urllib.request.urlopen, "_clamped", False):
        orig = urllib.request.urlopen

        def urlopen(req, timeout=None, **kw):
            return orig(req, timeout=min(timeout or CLIENT_WAIT_S, CLIENT_WAIT_S), **kw)
        urlopen._clamped = True
        urllib.request.urlopen = urlopen
    if "--server" in sys.argv:  # 기본 서버가 안 될 때: 다른 공개 Overpass 서버를 맨 앞에 둔다
        url = sys.argv[sys.argv.index("--server") + 1]
        if overpass_fetch.SERVERS[0] != url:
            overpass_fetch.SERVERS.insert(0, url)
    path = os.path.join(RAW, name)
    if os.path.exists(path):
        return
    os.makedirs(RAW, exist_ok=True)
    with open(os.path.join(RAW, name.replace(".json", ".overpassql")), "w", encoding="utf-8") as f:
        f.write(q)
    for attempt in range(2):
        print("받기:", name, flush=True)
        if not overpass_fetch.fetch(q, path):
            sys.exit(f"받기 실패: {name}")
        time.sleep(20)  # 다음 요청 전에 쉰다(공개 서버 예의)
        base = osm_base(path)
        if base >= MIN_OSM_BASE:
            return
        # 대체 서버의 자료가 오래되면(2026-07 자료가 온 적이 있다) 버리고 한 번만 다시 받는다
        print(f"  자료 시각이 오래됨({base}) — 버리고 다시 받는다", flush=True)
        os.remove(path)
        time.sleep(40)
    sys.exit(f"받기 실패(오래된 자료): {name}")


MIN_OSM_BASE = "2026-11-01"


def osm_base(path):
    with open(path, encoding="utf-8") as f:
        head = f.read(600)
    m = re.search(r'"timestamp_osm_base":\s*"([^"]+)"', head)
    return m.group(1) if m else ""


def fetch_missing():
    order = ("depots_", "corridor_", "near_", "named_")  # 중요한 것부터
    failed = []
    for name, q in sorted(QUERIES, key=lambda nq: [nq[0].startswith(p) for p in order].index(True)):
        if "--quick" in sys.argv and name.startswith(("near_", "named_")):
            continue  # 서버가 바쁠 때: 기지·회랑·도로만 받는다(빠진 파일은 점검 결과에 남는다)
        try:
            fetch_one(name, q)
        except SystemExit as e:  # 하나가 안 되어도 나머지는 받는다
            print("받기 실패, 건너뜀:", e, flush=True)
            failed.append(name)
    return failed


def load(name):
    with open(os.path.join(RAW, name), encoding="utf-8") as f:
        d = json.load(f)
    if d.get("remark"):
        sys.exit(f"{name}: Overpass remark(시간 초과 등) — 다시 받아야 함: {d['remark'][:200]}")
    base = d.get("osm3s", {}).get("timestamp_osm_base", "")
    if base < MIN_OSM_BASE:
        sys.exit(f"{name}: 자료 시각이 오래됨({base}) — 지우고 다시 받아야 함")
    return d["elements"]


def load_opt(name, stats):
    """없으면 빈 목록(받기 실패). 점검 결과에 빠진 파일로 남긴다."""
    if not os.path.exists(os.path.join(RAW, name)):
        print(f"경고: {name} 없음 — 빼고 만든다", flush=True)
        stats.setdefault("missing_raw", []).append(name)
        return []
    return load(name)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def decode_polyline(s):
    """graph.json 의 Google 인코딩 폴리라인(소수 5자리)을 [(lat, lon), ...]으로 푼다."""
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _ in range(2):
            r = sh = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                r |= (b & 31) << sh
                sh += 5
                if b < 32:
                    break
            vals.append(~(r >> 1) if r & 1 else r >> 1)
        lat += vals[0]
        lon += vals[1]
        pts.append((lat / 1e5, lon / 1e5))
    return pts


def seg_nearest(p, a, b):
    """점 p에서 선분 a-b까지: (거리 m, 선분 위 비율 t, 가장 가까운 점)."""
    (x1, y1), (x2, y2) = to_xy(a, p), to_xy(b, p)
    dx, dy = x2 - x1, y2 - y1
    seg2 = dx * dx + dy * dy
    t = 0 if seg2 == 0 else max(0.0, min(1.0, -(x1 * dx + y1 * dy) / seg2))
    return math.hypot(x1 + t * dx, y1 + t * dy), t, (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))


class Grid:
    """선분이나 점을 격자(약 220m 칸)에 넣어 '이 점 근처'를 빨리 찾는다."""
    CELL = 0.002

    def __init__(self):
        self.cells = defaultdict(list)

    def _c(self, v):
        return int(math.floor(v / self.CELL))

    def add_seg(self, item, a, b):
        for cy in range(self._c(min(a[0], b[0])), self._c(max(a[0], b[0])) + 1):
            for cx in range(self._c(min(a[1], b[1])), self._c(max(a[1], b[1])) + 1):
                self.cells[(cy, cx)].append(item)

    def add_pt(self, item, p):
        self.cells[(self._c(p[0]), self._c(p[1]))].append(item)

    def near(self, p, radius_m):
        r = int(radius_m / 180) + 1
        cy, cx = self._c(p[0]), self._c(p[1])
        seen = set()
        for y in range(cy - r, cy + r + 1):
            for x in range(cx - r, cx + r + 1):
                for item in self.cells.get((y, x), ()):
                    if item not in seen:
                        seen.add(item)
                        yield item


# ---------- 그래프 ----------
class Graph:
    def __init__(self):
        g = load_json(GRAPH)
        self.g = g
        T, N, E = g["tables"], g["nodes"], g["edges"]
        self.lat = [v / 1e5 for v in N["lat"]]
        self.lon = [v / 1e5 for v in N["lon"]]
        self.f = N["f"]
        self.ea, self.eb, self.elen, self.es, self.ek = E["a"], E["b"], E["len"], E["s"], E["k"]
        self.esvc, self.els, self.erg, self.eg, self.etn = E["svc"], E["ls"], E["rg"], E["g"], E["tn"]
        self.structs = T["structs"]
        self.TUN = self.structs.index("tunnel")
        self.lines, self.line_short, self.line_metro = T["lines"], T["line_short"], T["line_metro"]
        self.line_sets, self.track_names = T["line_sets"], T["track_names"]
        self.regions = [r["name"] for r in T["regions"]]
        self.stations = g["stations"]
        self.n_nodes, self.n_edges = len(self.lat), len(self.ea)
        self.adj = defaultdict(list)  # 선로 간선만: 노드 → [(간선, 반대쪽 노드)]
        for j in range(self.n_edges):
            if self.ek[j] == 0:
                self.adj[self.ea[j]].append((j, self.eb[j]))
                self.adj[self.eb[j]].append((j, self.ea[j]))
        self.station_of = {}  # 선로 위 역 부착점 → 역 번호
        for si, s in enumerate(self.stations):
            for n in s["plat"]:
                self.station_of[n] = si
        self._geom = {}
        # 역이 있는 연결 요소(모든 간선 기준) = 길 찾기로 닿을 수 있는 곳
        parent = list(range(self.n_nodes))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for j in range(self.n_edges):
            parent[find(self.ea[j])] = find(self.eb[j])
        self.comp = [find(i) for i in range(self.n_nodes)]
        self.station_comps = {self.comp[h] for s in self.stations for h in s["hubs"]}

    def pt(self, n):
        return (self.lat[n], self.lon[n])

    def geom(self, j):
        if j not in self._geom:
            pts = decode_polyline(self.eg[j]) if self.eg[j] else [self.pt(self.ea[j]), self.pt(self.eb[j])]
            cum = [0.0]
            for a, b in zip(pts, pts[1:]):
                cum.append(cum[-1] + haversine_m(a, b))
            self._geom[j] = (pts, cum)
        return self._geom[j]

    def edge_lines(self, j):
        return self.line_sets[self.els[j]]

    def label(self, line_idx, tn_idx=()):
        """안내용 짧은 노선 이름(최대 2개). 도시철도·광역전철 노선이 있으면 그것, 없으면 선 이름에서 온 노선 이름."""
        metro = sorted({self.line_short[l] for l in line_idx if self.line_metro[l]})
        if metro:
            return "·".join(metro[:2])
        other = sorted({self.lines[l] for l in line_idx})
        if other:
            return "·".join(other[:2])
        names = sorted({self.track_names[t] for t in tn_idx if t})
        return "·".join(names[:2]) or "선로"

    def first_station(self, start, first_edge, limit_m=80000):
        """start 노드에서 first_edge 쪽으로 선로를 따라 가장 먼저 닿는 역: (역 번호, 거리 m) 또는 (None, None)."""
        other = self.eb[first_edge] if self.ea[first_edge] == start else self.ea[first_edge]
        best = {other: self.elen[first_edge]}
        heap = [(self.elen[first_edge], other)]
        done = {start}
        while heap:
            d, n = heapq.heappop(heap)
            if n in done:
                continue
            done.add(n)
            if n in self.station_of:
                return self.station_of[n], d
            if d > limit_m:
                break
            for j, m in self.adj[n]:
                if m not in done:
                    nd = d + self.elen[j]
                    if nd < best.get(m, 1e18):
                        best[m] = nd
                        heapq.heappush(heap, (nd, m))
        return None, None

    def station_name(self, si):
        return self.stations[si]["name"] if si is not None else None


def between_name(gr, label, a, b, what):
    """'<노선> <역A>–<역B> <what>' 이름. 한쪽만 있으면 '<역> 부근'."""
    na, nb = gr.station_name(a), gr.station_name(b)
    if na and nb and na != nb:
        return f"{label} {na}–{nb} {what}"
    if na or nb:
        return f"{label} {na or nb} 부근 {what}"
    return f"{label} {what}"


# ---------- 시·도 ----------
class Regions:
    def __init__(self):
        from build_places import Poly  # 시·도 다각형(짝수-홀수 규칙)
        rels = [e for e in load_json(os.path.join(ROOT, "data", "raw", "basemap", "admin.json"))["elements"]
                if e["type"] == "relation"]
        self.polys = [Poly(r) for r in rels]

    def of(self, lat, lon):
        for p in self.polys:
            if p.contains(lat, lon):
                return p.name
        return None


# ---------- 1. 터널 출입구 ----------
PORTAL_CLUSTER_M = 60


def osm_portal_nodes():
    """OSM 노드 중 터널 선로와 터널 아닌 선로가 만나는 점: 좌표(소수 5자리) → OSM 노드 ID."""
    kinds = defaultdict(set)
    coord = {}
    for w in load_json(WAYS):
        t = w["tags"].get("tunnel")
        tun = bool(t and t != "no")
        for n, p in zip(w["nodes"], w["geom"]):
            kinds[n].add(tun)
            coord[n] = p
    out = {}
    for n, k in kinds.items():
        if len(k) == 2:
            p = coord[n]
            out[(round(p[0] * 1e5), round(p[1] * 1e5))] = n
    return out


def build_portals(gr, stats):
    osm_at = osm_portal_nodes()
    portals = [n for n in range(gr.n_nodes) if gr.f[n] & 1]
    info = {}
    for n in portals:
        tun, out = [], []
        for j, _ in gr.adj[n]:
            (tun if gr.es[j] == gr.TUN else out).append(j)
        main = any(gr.esvc[j] == 0 for j in tun + out)
        info[n] = (tun, out, main)
    # 본선 출입구를 먼저 씨앗으로 삼아, 60m 안의 출입구(나란한 선로·측선)를 한 묶음으로 만든다
    order = sorted(portals, key=lambda n: (not info[n][2], n))
    grid = Grid()
    for n in portals:
        grid.add_pt(n, gr.pt(n))
    assigned = set()
    clusters = []
    for n in order:
        if n in assigned:
            continue
        members = [m for m in grid.near(gr.pt(n), PORTAL_CLUSTER_M)
                   if m not in assigned and haversine_m(gr.pt(n), gr.pt(m)) <= PORTAL_CLUSTER_M]
        members.sort(key=lambda m: (m != n, m))
        assigned.update(members)
        clusters.append(members)
    items = []
    unreachable = []
    for members in clusters:
        rep = members[0]
        tun, out, main = info[rep]
        if not tun or not out:
            continue  # 출입구 표시인데 양쪽 구조가 없으면(있을 수 없음) 건너뛴다
        if gr.comp[rep] not in gr.station_comps:  # 역과 이어지지 않은 선로(레일바이크·화물 부두선 등): 길 찾기로 못 감
            unreachable.append({"node": rep, "lat": gr.lat[rep], "lon": gr.lon[rep],
                                "track": gr.label(set(gr.edge_lines(tun[0])), {gr.etn[tun[0]]})})
            continue
        lines, outs, svc_only = set(), Counter(), True
        tns = set()
        for m in members:
            mt, mo, mm = info[m]
            svc_only &= not mm
            for j in mt + mo:
                lines.update(gr.edge_lines(j))
                tns.add(gr.etn[j])
            for j in mo:
                outs[gr.structs[gr.es[j]]] += 1
        te, oe = tun[0], out[0]
        a, _ = gr.first_station(rep, te)
        b, _ = gr.first_station(rep, oe)
        label = gr.label(lines, tns)
        notes = []
        if len(members) > 1:
            notes.append(f"선로 {len(members)}개")
        notes.append("바깥: " + "·".join({"ground": "지상", "bridge": "교량"}[s] for s in sorted(outs, key=lambda s: s != "ground")))
        if svc_only:
            notes.append("측선(차량기지·측선 선로)")
        notes.append(f"터널 쪽 첫 역 {gr.station_name(a) or '없음'}, 바깥쪽 첫 역 {gr.station_name(b) or '없음'}")
        osm = osm_at.get((round(gr.lat[rep] * 1e5), round(gr.lon[rep] * 1e5)))
        items.append({
            "k": "portal", "name": between_name(gr, label, a, b, "터널 출입구"),
            "lat": round(gr.lat[rep], 5), "lon": round(gr.lon[rep], 5),
            "node": rep, "edge": te, "t": 0.0 if gr.ea[te] == rep else 1.0,
            "lines": sorted(lines), "note": " · ".join(notes),
            "nodes": members, "osm": f"node/{osm}" if osm else None,
            "_svc_only": svc_only, "_rg": gr.erg[te],
        })
    stats["portal_nodes"] = len(portals)
    stats["portal_clusters"] = len(items)
    stats["portal_unreachable_dropped"] = unreachable
    stats["portal_osm_matched"] = sum(1 for it in items if it["osm"])
    return items


# ---------- 2. 환기구·수직구·비상구 ----------
SHAFT_RE = re.compile(SHAFT_WORDS)
EXIT_RE = re.compile(EXIT_WORDS)


def tunnel_index(gr):
    grid = Grid()
    for j in range(gr.n_edges):
        if gr.ek[j] == 0 and gr.es[j] == gr.TUN:
            pts, _ = gr.geom(j)
            for si, (a, b) in enumerate(zip(pts, pts[1:])):
                grid.add_seg((j, si), a, b)
    return grid


def snap_tunnel(gr, grid, p, radius_m):
    """반경 안의 터널 간선마다 가장 가까운 점: [(거리, 간선, t, 점)] 가까운 순."""
    best = {}
    for j, si in grid.near(p, radius_m):
        pts, cum = gr.geom(j)
        d, t, q = seg_nearest(p, pts[si], pts[si + 1])
        if d <= radius_m and (j not in best or d < best[j][0]):
            total = cum[-1] or 1.0
            best[j] = (d, j, (cum[si] + t * (cum[si + 1] - cum[si])) / total, q)
    return sorted(best.values())


def patterns(tags):
    """보고용 태그 패턴 목록."""
    out = []
    for k in ("man_made", "railway", "building", "entrance", "exit", "emergency"):
        if k in tags:
            v = tags[k]
            if k == "man_made" and v == "tower":
                v += f"(tower:type={tags.get('tower:type', '-')})"
            out.append(f"{k}={v}")
    if tags.get("highway") == "steps":
        out.append("highway=steps" + ("+tunnel" if "tunnel" in tags else "") +
                   ("+level<0" if str(tags.get("level", "")).startswith("-") else "") +
                   ("+layer<0" if str(tags.get("layer", "")).startswith("-") else ""))
    nm = tags.get("name", "")
    for w in (SHAFT_WORDS + "|" + EXIT_WORDS).split("|"):
        if w in nm:
            out.append(f"name~{w}")
    return out or ["(기타)"]


def feature_kind(tags):
    nm = tags.get("name", "") + " " + tags.get("description", "")
    if (tags.get("man_made") == "ventilation_shaft" or tags.get("railway") == "ventilation_shaft"
            or tags.get("building") in ("ventilation_shaft", "ventilation")
            or (tags.get("man_made") == "tower" and tags.get("tower:type") == "ventilation")
            or SHAFT_RE.search(nm)):
        return "shaft"
    if (tags.get("entrance") == "emergency" or tags.get("exit") == "emergency"
            or tags.get("railway") == "emergency_exit" or EXIT_RE.search(nm)):
        return "emergency_exit"
    return None


def element_pt(e):
    if "lat" in e:
        return (e["lat"], e["lon"])
    c = e.get("center")
    return (c["lat"], c["lon"]) if c else None


def build_shafts(gr, tgrid, stats):
    feats = {}
    sources = defaultdict(set)
    for name in [f"near_{k}.json" for k in TILES] + [f"named_{i}.json" for i in range(len(BANDS))]:
        for e in load_opt(name, stats):
            key = f"{e['type']}/{e['id']}"
            feats[key] = e
            sources[key].add(name.split(".")[0])
    pat_all, pat_near = Counter(), Counter()
    dist_bins = Counter()
    items, rejected = [], []
    for key, e in sorted(feats.items()):
        tags = e.get("tags", {})
        p = element_pt(e)
        if p is None:
            continue
        snaps = snap_tunnel(gr, tgrid, p, 500)
        d = snaps[0][0] if snaps else None
        pats = patterns(tags)
        kind = feature_kind(tags)
        for pt_ in pats:
            pat_all[pt_] += 1
            if d is not None and d <= NEAR_M:
                pat_near[pt_] += 1
        if kind:
            dist_bins[(kind, "<=80m" if d is not None and d <= NEAR_M else ("80-500m" if d is not None else ">500m"))] += 1
        if not kind or d is None or d > NEAR_M:
            if kind and d is not None:
                rejected.append({"osm": key, "kind": kind, "name": tags.get("name"), "dist_m": round(d), "tags": tags})
            continue
        d0, j, t, q = snaps[0]
        also = [[jj, round(tt, 4)] for dd, jj, tt, _ in snaps[1:] if dd <= NEAR_M and dd <= d0 + 40][:4]
        # 이름: OSM 이름이 있으면 그것, 없으면 '<노선> <역A>–<역B> 환기구·수직구/비상 출구'
        lines = set(gr.edge_lines(j))
        label = gr.label(lines, {gr.etn[j]})
        sa, _ = gr.first_station(gr.eb[j], j)  # 간선 a 쪽으로 가장 먼저 닿는 역
        sb, _ = gr.first_station(gr.ea[j], j)  # 간선 b 쪽
        what = "환기구·수직구" if kind == "shaft" else "비상 출구"
        name = tags.get("name") or between_name(gr, label, sa, sb, what)
        notes = [f"OSM {', '.join(pats)}", f"터널 선로까지 {round(d0)}m"]
        if not tags.get("name"):
            notes.append("이름 없음(가까운 역으로 지은 이름)")
        notes.append("지상 출입·계단 유무는 OSM에 없음(확인 안 됨)")
        items.append({
            "k": kind, "name": name, "lat": round(p[0], 5), "lon": round(p[1], 5),
            "node": None, "edge": j, "t": round(t, 4), "lines": sorted(lines), "note": " · ".join(notes),
            "also": also, "osm": key, "_rg": gr.erg[j], "_src": sorted(sources[key]),
        })
    # 30m 안의 같은 종류(같은 환기구를 점 여러 개로 그린 것)는 하나로 합친다
    merged = []
    for it in items:
        tgt = next((m for m in merged if m["k"] == it["k"] and
                    haversine_m((m["lat"], m["lon"]), (it["lat"], it["lon"])) <= 30), None)
        if tgt:
            tgt["_merged"].append(it["osm"])
            continue
        it["_merged"] = []
        merged.append(it)
    for it in merged:
        if it["_merged"]:
            it["note"] += f" · 30m 안의 OSM 점 {1 + len(it['_merged'])}개를 합침({', '.join(it['_merged'])})"
    items = merged
    stats["shaft_features_fetched"] = len(feats)
    stats["shaft_tag_patterns_all"] = dict(pat_all.most_common())
    stats["shaft_tag_patterns_within_80m"] = dict(pat_near.most_common())
    stats["shaft_kind_by_distance"] = {f"{k}|{b}": v for (k, b), v in sorted(dist_bins.items())}
    stats["shaft_candidates_80_500m"] = rejected[:60]
    return items, feats


# ---------- 3. 차량기지 ----------
DEPOT_RE = re.compile(r"차량기지|차량사업소|검수고|검수기지|정비기지|차량정비|주박기지|차량관리단|철도차량|기지|사업소|정비단|차량센터")
DEPOT_NOT_RE = re.compile(r"군사|공군|해군|육군|미군|기지국|통신|송신|역$|역사$|정거장")
GATE_BARRIERS = {"gate", "lift_gate", "sliding_gate", "swing_gate", "entrance", "full-height_turnstile",
                 "turnstile", "hampshire_gate", "chain", "bollard"}
ROAD_RE = "^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|road|pedestrian|" \
          "trunk_link|primary_link|secondary_link|tertiary_link)$"


class Area:
    """OSM 면(way·relation) 또는 점. 다각형 안 판정은 짝수-홀수 규칙(멤버 선분을 이어 붙이지 않아도 된다)."""

    def __init__(self, e):
        self.key = f"{e['type']}/{e['id']}"
        self.tags = e.get("tags", {})
        self.name = (self.tags.get("name") or "").strip()
        self.segs = []
        if e["type"] == "way" and "geometry" in e:
            g = [(q["lat"], q["lon"]) for q in e["geometry"] if q]
            if len(g) >= 4 and g[0] == g[-1]:
                self.segs = list(zip(g, g[1:]))
        elif e["type"] == "relation":
            for m in e.get("members", []):
                if m.get("type") == "way" and m.get("role") in ("outer", "inner", "") and m.get("geometry"):
                    g = [(q["lat"], q["lon"]) for q in m["geometry"] if q]
                    self.segs += list(zip(g, g[1:]))
        if self.segs:
            lats = [a[0] for a, _ in self.segs]
            lons = [a[1] for a, _ in self.segs]
            self.bbox = (min(lats), min(lons), max(lats), max(lons))
            self.pt = ((self.bbox[0] + self.bbox[2]) / 2, (self.bbox[1] + self.bbox[3]) / 2)
            # 넓이(평면 근사, m²): 신발끈 공식(닫힌 way만 정확. relation은 대략)
            o = self.pt
            s = 0.0
            for a, b in self.segs:
                (x1, y1), (x2, y2) = to_xy(a, o), to_xy(b, o)
                s += x1 * y2 - x2 * y1
            self.area = abs(s) / 2
        else:
            p = element_pt(e) or ((e.get("bounds") or {}).get("minlat"), (e.get("bounds") or {}).get("minlon"))
            self.pt = p
            self.bbox = (p[0], p[1], p[0], p[1]) if p[0] is not None else None
            self.area = 0.0
        self.pts = [self.pt]  # 경계가 없을 때 도로를 찾을 기준점들

    def contains(self, p):
        if not self.segs:
            return False
        b = self.bbox
        if not (b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3]):
            return False
        inside = False
        lat, lon = p
        for (y1, x1), (y2, x2) in self.segs:
            if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
        return inside

    def boundary_dist(self, p):
        """경계까지 (거리 m, 경계 위 가장 가까운 점)."""
        best = (1e18, None)
        for a, b in self.segs:
            d, _, q = seg_nearest(p, a, b)
            if d < best[0]:
                best = (d, q)
        return best


class YardCluster:
    """OSM 기지 면에 들지 않은 큰 측선 묶음(그래프의 svc=yard·siding 간선이 서로 이어진 것). 경계가 없다."""

    def __init__(self, idx, nodes, gr):
        self.key = f"graph-yard/{idx}"
        self.tags, self.name, self.segs, self.area = {}, "", [], 0.0
        pts = [gr.pt(n) for n in nodes]
        self.bbox = (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))
        self.pt = ((self.bbox[0] + self.bbox[2]) / 2, (self.bbox[1] + self.bbox[3]) / 2)
        self.pts = pts

    def contains(self, p):
        return False


YARD_CLUSTER_MIN_M = 2000  # 측선(svc=yard) 길이가 이보다 긴 묶음만 기지·조차장으로 본다
YARD_NAME_RE = re.compile(r"기지|검수|주박|차량|조차장")


def yard_clusters(gr, taken_nodes, stats):
    """측선(yard·siding) 간선을 이어진 묶음으로 나누고, OSM 기지에 이미 든 것은 뺀다."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    side = [j for j in range(gr.n_edges) if gr.ek[j] == 0 and gr.esvc[j] in (1, 2)]
    for j in side:
        parent[find(gr.ea[j])] = find(gr.eb[j])
    groups = defaultdict(list)
    for j in side:
        groups[find(gr.ea[j])].append(j)
    out = []
    for edges in groups.values():
        yard_m = sum(gr.elen[j] for j in edges if gr.esvc[j] == 1)
        if yard_m < YARD_CLUSTER_MIN_M:
            continue
        nodes = sorted({n for j in edges for n in (gr.ea[j], gr.eb[j])})
        if len(set(nodes) & taken_nodes) >= 0.3 * len(nodes):
            continue
        names = Counter(gr.track_names[gr.etn[j]] for j in edges if gr.etn[j])
        out.append((nodes, yard_m, names))
    stats["yard_clusters_added"] = len(out)
    return out


def half_diag(host):
    """경계 상자 대각선의 절반(m): 가운데에서 이 거리 안을 찾으면 면 전체가 들어온다."""
    b = host.bbox
    return haversine_m((b[0], b[1]), (b[2], b[3])) / 2


def depot_candidates(stats):
    els, seen = [], set()
    missing = [i for i in range(len(BANDS)) if not os.path.exists(os.path.join(RAW, f"depots_{i}.json"))]
    if missing:
        print(f"경고: depots_{missing}.json 없음 — OSM 기지 면 없이 측선 묶음만 쓴다", flush=True)
        stats["depot_osm_missing"] = missing
    for i in range(len(BANDS)):
        if i in missing:
            continue
        for e in load(f"depots_{i}.json"):
            if (e["type"], e["id"]) not in seen:  # 띠 경계에 걸친 것은 두 번 온다
                seen.add((e["type"], e["id"]))
                els.append(e)
    areas = [Area(e) for e in els]
    cand = []
    for a in areas:
        t = a.tags
        named_depot = bool(a.name and DEPOT_RE.search(a.name) and not DEPOT_NOT_RE.search(a.name))
        rw = t.get("railway") in ("depot", "workshop", "yard", "wash", "traverser")
        if not (named_depot or rw):
            continue
        if t.get("railway") and not rw and t.get("railway") not in ("signal_box",):
            continue  # 이름에 '기지'가 든 선로 way(예: 오송정비기지선, 인입선)는 기지가 아니다
        if not a.name and not a.segs and t.get("railway") in ("traverser", "wash"):
            a.weak = True  # 이름 없는 천차대·세척선 점: 기지 면 안에 들 때만 쓴다
        if a.pt is None or a.pt[0] is None:
            continue
        # landuse=railway 가 아닌 이름(예: 다른 시설의 '기지')은 railway 관련 태그가 있을 때만
        if named_depot and not rw and t.get("landuse") != "railway" and not any(
                k in t for k in ("railway", "operator")) and t.get("building") is None:
            continue
        cand.append(a)
    stats["depot_elements_fetched"] = len(els)
    stats["depot_landuse_railway"] = sum(1 for a in areas if a.tags.get("landuse") == "railway")
    stats["depot_candidates"] = len(cand)
    stats["depot_candidate_tags"] = dict(Counter(
        "+".join(f"{k}={a.tags[k]}" for k in ("landuse", "railway", "building") if k in a.tags) or "(이름만)"
        for a in cand).most_common())
    return cand, [a for a in areas if a.tags.get("landuse") == "railway"]


def group_depots(gr, cand, landuse_areas):
    """같은 기지를 가리키는 요소들을 묶는다: 면 안에 든 점·건물은 그 면에, 이름 없는 railway=depot 점은
    그 점을 품은 철도 용지(landuse=railway) 면을 경계로 쓴다."""
    polys = sorted([a for a in cand if a.segs], key=lambda a: -a.area)
    groups = []  # [대표 면 또는 점, [요소들]]
    for a in polys:
        host = None
        for g in groups:
            if g[0].segs and g[0].contains(a.pt) and g[0].area > a.area * 1.5:
                host = g
                break
        if host:
            host[1].append(a)
        else:
            groups.append([a, [a]])
    for a in [a for a in cand if not a.segs]:
        host = next((g for g in groups if g[0].contains(a.pt)), None)
        if host:
            host[1].append(a)
            continue
        land = [l for l in landuse_areas if l.contains(a.pt)]
        if land:
            l = min(land, key=lambda x: x.area)
            groups.append([l, [a, l]])
        elif not getattr(a, "weak", False):
            groups.append([a, [a]])
    return groups


def depot_name(members):
    """이름: 기지 낱말이 든 이름을 우선, 그다음 면 이름."""
    names = [m.name for m in members if m.name]
    good = [n for n in names if re.search(r"차량기지|차량사업소|기지|사업소|검수", n) and not DEPOT_NOT_RE.search(n)]
    return (good or names or [None])[0]


def build_depots(gr, stats):
    cand, landuse_areas = depot_candidates(stats)
    groups = group_depots(gr, cand, landuse_areas)
    # 선로 간선의 선 모양 꼭짓점 색인. 간선은 차수 2 노드를 없앤 것이라 양 끝이 기지 밖에 있을 수 있어
    # '선 모양이 기지 안을 지나는 간선'을 찾고 그 양 끝 노드를 기지 노드로 쓴다.
    vgrid = Grid()
    for j in range(gr.n_edges):
        if gr.ek[j] == 0:
            for p in gr.geom(j)[0]:
                vgrid.add_pt(j, p)
    depots, dropped = [], []
    for host, members in groups:
        if host.segs:
            edges = [j for j in vgrid.near(host.pt, half_diag(host) + 50)
                     if any(host.contains(p) for p in gr.geom(j)[0])]
            how = "면 안"
        else:
            edges = [j for j in vgrid.near(host.pt, 400)
                     if any(haversine_m(host.pt, p) <= 400 for p in gr.geom(j)[0])]
            how = "점 400m 안"
        yard_e = [j for j in edges if gr.esvc[j] != 0]
        yn = sorted({n for j in yard_e for n in (gr.ea[j], gr.eb[j])})
        nodes = yn or sorted({n for j in edges for n in (gr.ea[j], gr.eb[j])})
        name = depot_name(members)
        if not nodes:
            dropped.append({"osm": host.key, "name": name, "why": "그래프 선로 없음"})
            continue
        reach = [n for n in nodes if gr.comp[n] in gr.station_comps]
        if not reach:
            dropped.append({"osm": host.key, "name": name, "why": "역과 이어지지 않은 선로"})
            continue
        depots.append({"host": host, "members": members, "name": name, "nodes": nodes, "reach": reach,
                       "yard_only": bool(yn), "how": how})
    # 같은 노드를 나눠 가지는 기지(면이 겹침)는 하나로 합친다
    merged = []
    for d in sorted(depots, key=lambda d: -len(d["nodes"])):
        s = set(d["nodes"])
        tgt = next((m for m in merged if len(s & set(m["nodes"])) >= 0.5 * len(s)), None)
        if tgt:
            tgt["members"] += d["members"]
            if not tgt["name"] and d["name"]:
                tgt["name"] = d["name"]
            continue
        merged.append(d)
    # OSM 기지 면에 들지 않은 큰 측선 묶음(조차장·이름 없는 기지)
    taken = {n for d in merged for n in d["nodes"]}
    for idx, (nodes, yard_m, names) in enumerate(yard_clusters(gr, taken, stats)):
        reach = [n for n in nodes if gr.comp[n] in gr.station_comps]
        if not reach:
            continue
        nm = next((n for n, _ in names.most_common() if YARD_NAME_RE.search(n)), None)
        merged.append({"host": YardCluster(idx, nodes, gr), "members": [], "name": None, "track_name": nm,
                       "nodes": nodes, "reach": reach, "yard_only": True, "how": "측선 묶음", "yard_m": yard_m})
    stats["depot_groups"] = len(groups)
    stats["depot_dropped"] = dropped
    return merged


def depot_road_query(depots):
    parts = []
    for d in depots:
        b = d["host"].bbox if d["host"].segs else None
        if b is None:
            p = d["host"].pt
            b = (p[0], p[1], p[0], p[1])
        m = 0.004  # 약 400m 여유
        bb = f"{b[0] - m:.5f},{b[1] - m:.5f},{b[2] + m:.5f},{b[3] + m:.5f}"
        parts.append(f'  way({bb})[highway~"{ROAD_RE}"];\n  node({bb})[barrier];\n  node({bb})[entrance];')
    return ('[out:json][timeout:600];\n// 차량기지 둘레(약 400m 여유)의 공공 도로와 출입문 후보\n(\n' +
            "\n".join(parts) + "\n);\nout geom tags;")


def depot_exits(gr, depots, stats):
    if not os.path.exists(os.path.join(RAW, ROADS_FILE)):
        print(f"경고: {ROADS_FILE} 없음 — 기지 나가는 곳을 대표 측선 노드로 둔다", flush=True)
        stats["depot_roads_missing"] = True
        for d in depots:
            rep = min(d["reach"], key=lambda n: (haversine_m(gr.pt(n), d["host"].pt), n))
            d["exit"], d["gate"] = gr.pt(rep), None
            d["exit_how"] = "도로·출입문 자료를 받지 못함: 기지 가운데에 가까운 측선 노드 위치(근사)"
        return
    els = load(ROADS_FILE)
    gates, roads = [], []
    for e in els:
        t = e.get("tags", {})
        if e["type"] == "node" and (t.get("barrier") in GATE_BARRIERS or "entrance" in t):
            gates.append(e)
        elif e["type"] == "way" and "geometry" in e:
            g = [(q["lat"], q["lon"]) for q in e["geometry"] if q]
            roads.append((e["id"], t, g))
    rgrid = Grid()
    for ri, (_, _, g) in enumerate(roads):
        for si, (a, b) in enumerate(zip(g, g[1:])):
            rgrid.add_seg((ri, si), a, b)
    ggrid = Grid()
    for gi, e in enumerate(gates):
        ggrid.add_pt(gi, (e["lat"], e["lon"]))

    inside_cache = {}  # (기지 키, 도로 선분) → 선분 가운데가 기지 면 안인지(기지 안 도로는 빼려고)

    def nearest_road(p, radius=400, poly=None):
        best = (1e18, None, None)
        for ri, si in rgrid.near(p, radius):
            g = roads[ri][2]
            d, _, q = seg_nearest(p, g[si], g[si + 1])
            if d < best[0]:
                if poly is not None:
                    key = (poly.key, ri, si)
                    if key not in inside_cache:
                        a, b = g[si], g[si + 1]
                        inside_cache[key] = poly.contains(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))
                    if inside_cache[key]:
                        continue
                best = (d, q, roads[ri])
        return best

    n_gate = 0
    for d in depots:
        host = d["host"]
        exit_pt, gate, how = None, None, None
        if host.segs:
            cands = []
            for gi in ggrid.near(host.pt, half_diag(host) + 100):
                e = gates[gi]
                p = (e["lat"], e["lon"])
                bd, _ = host.boundary_dist(p)
                if bd <= 40:
                    rd, _, _ = nearest_road(p, 300)
                    t = e.get("tags", {})
                    main = "정문" in (t.get("name") or "")
                    cands.append((not main, t.get("barrier") not in ("gate", "lift_gate", "sliding_gate", "swing_gate", "entrance"),
                                  rd, e["id"], p, t))
            if cands:
                cands.sort()
                _, _, rd, gid, p, t = cands[0]
                exit_pt, gate = p, gid
                how = f"출입문(OSM node/{gid}, {'barrier=' + t['barrier'] if 'barrier' in t else 'entrance=' + t.get('entrance', '')})"
                if rd < 1e17:
                    how += f", 도로까지 {round(rd)}m"
                n_gate += 1
            else:
                # 경계를 40m 간격으로 짚어 가장 가까운 공공 도로(먼저 120m 안, 없으면 400m 안을 성기게)
                samples = []
                for a, b in host.segs:
                    k = max(1, int(haversine_m(a, b) / 40))
                    samples += [(a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k) for i in range(k)]
                best = (1e18, None, None)
                for radius, pts in ((120, samples), (400, samples[::5])):
                    for p in pts:
                        rd, q, road = nearest_road(p, radius, host)
                        if rd < best[0]:
                            best = (rd, p, road)
                    if best[1] is not None:
                        break
                if best[1] is not None:
                    exit_pt = best[1]
                    road = best[2]
                    rn = road[1].get("name") or road[1].get("ref") or f"highway={road[1].get('highway')}"
                    how = f"출입문 표시 없음: 공공 도로({rn})에 가장 가까운 경계 지점, 도로까지 {round(best[0])}m (근사)"
        if exit_pt is None:
            # 경계가 없으면(점으로만 그린 기지, 측선 묶음) 기준점들(측선 노드) 중 공공 도로에 가장 가까운 곳
            best = (1e18, None, None, None)
            pts = host.pts if len(host.pts) <= 200 else host.pts[::len(host.pts) // 200 + 1]
            for radius, ps in ((120, pts), (400, pts[::5] or pts)):
                for p in ps:
                    rd, q, road = nearest_road(p, radius)
                    if rd < best[0]:
                        best = (rd, q, road, p)
                if best[1] is not None:
                    break
            if best[1] is not None:
                exit_pt = best[1]
                rn = best[2][1].get("name") or f"highway={best[2][1].get('highway')}"
                what = "측선" if isinstance(host, YardCluster) else "기지 점"
                how = f"기지 경계 없음: {what}에서 가장 가까운 공공 도로({rn}) 위 지점, 선로에서 {round(best[0])}m (근사)"
            else:
                exit_pt = host.pt
                how = "기지 경계·400m 안 공공 도로 없음: 기지 가운데 위치 (근사)"
        d["exit"], d["gate"], d["exit_how"] = exit_pt, gate, how
    stats["depot_gates_mapped"] = n_gate
    stats["depot_roads_fetched"] = len(roads)
    stats["depot_gate_candidates_fetched"] = len(gates)


def depot_approach(gr, d):
    """기지 측선 노드에서 선로를 따라 본선(svc=0) 간선이 붙은 노드까지의 가장 짧은 길. 그 길의 터널 길이와 이음 지점 구조."""
    src = set(d["nodes"])
    best = {n: 0.0 for n in src}
    prev = {}
    heap = [(0.0, n) for n in src]
    heapq.heapify(heap)
    done = set()
    goal = None
    while heap:
        dist, n = heapq.heappop(heap)
        if n in done:
            continue
        done.add(n)
        if any(gr.esvc[j] == 0 for j, _ in gr.adj[n]):
            goal = n
            break
        if dist > 30000:
            break
        for j, m in gr.adj[n]:
            nd = dist + gr.elen[j]
            if m not in done and nd < best.get(m, 1e18):
                best[m] = nd
                prev[m] = (n, j)
                heapq.heappush(heap, (nd, m))
    if goal is None:
        return None
    path, n = [], goal
    while n in prev:
        n, j = prev[n]
        path.append(j)
    tun_m = sum(gr.elen[j] for j in path if gr.es[j] == gr.TUN)
    gnd_m = sum(gr.elen[j] for j in path if gr.es[j] != gr.TUN)
    main_edges = [j for j, _ in gr.adj[goal] if gr.esvc[j] == 0]
    main_tun = all(gr.es[j] == gr.TUN for j in main_edges)
    return {"goal": goal, "tunnel_m": tun_m, "other_m": gnd_m, "main_tunnel": main_tun, "main_edges": main_edges}


def depot_items(gr, depots, stats):
    items = []
    for d in depots:
        ap = depot_approach(gr, d)
        # 대표 노드: 역과 이어진 측선 노드 중 나가는 곳에 가장 가까운 것
        rep = min(d["reach"], key=lambda n: (haversine_m(gr.pt(n), d["exit"]), n))
        lines, tns = set(), set()
        yard_len = tun_len = 0.0
        ns = set(d["nodes"])
        for n in d["nodes"]:
            for j, m in gr.adj[n]:
                if m in ns and gr.ea[j] == n:
                    yard_len += gr.elen[j]
                    if gr.es[j] == gr.TUN:
                        tun_len += gr.elen[j]
        main_lines = set()
        if ap:
            for j in ap["main_edges"]:
                main_lines.update(gr.edge_lines(j))
                tns.add(gr.etn[j])
        for n in d["nodes"]:
            for j, _ in gr.adj[n]:
                lines.update(gr.edge_lines(j))
        lines |= main_lines
        approach = None
        notes = []
        if ap:
            approach = "tunnel" if (ap["tunnel_m"] > 0 or ap["main_tunnel"]) else "surface"
            if approach == "tunnel":
                why = []
                if ap["main_tunnel"]:
                    why.append("본선과 만나는 곳이 터널 안")
                if ap["tunnel_m"] > 0:
                    why.append(f"기지 밖 진입 선로 중 터널 {round(ap['tunnel_m'])}m")
                notes.append("본선과 터널로 이어짐(" + ", ".join(why) + ")")
            else:
                notes.append("본선과 지상으로 이어짐")
            if main_lines:
                notes.append("이어지는 본선: " + gr.label(main_lines, tns))
        else:
            notes.append("본선과 이어지는 길을 30km 안에서 찾지 못함")
        if tun_len > 0:
            notes.append(f"기지 측선 중 터널 {round(tun_len)}m")
        if yard_len and tun_len / yard_len > 0.5:
            notes.append(f"기지 선로 대부분이 터널(지하 기지, {round(tun_len)}m/{round(yard_len)}m)")
        notes.append(f"나가는 곳: {d['exit_how']}")
        if not d["yard_only"]:
            notes.append("측선 표시가 없어 기지 안 본선 노드를 씀")
        name = d["name"]
        if isinstance(d["host"], YardCluster):
            notes.insert(0, f"OSM 기지 면 밖의 측선 묶음(측선 {d['yard_m'] / 1000:.1f}km): 차량기지·조차장·큰 역 구내일 수 있음")
        if not name:
            near_st = min(range(len(gr.stations)), key=lambda si: haversine_m(
                (gr.stations[si]["lat"] / 1e5, gr.stations[si]["lon"] / 1e5), gr.pt(rep)))
            if d.get("track_name"):
                name = f"{d['track_name']} 측선(OSM 기지 이름 없음, {gr.stations[near_st]['name']} 부근)"
            elif isinstance(d["host"], YardCluster):
                name = f"{gr.stations[near_st]['name']} 부근 측선·기지(OSM 이름 없음)"
            else:
                name = f"{gr.stations[near_st]['name']} 부근 차량기지(OSM 이름 없음)"
        rg_edge = next((j for j, _ in gr.adj[rep]), None)
        items.append({
            "k": "depot", "name": name, "lat": round(d["exit"][0], 5), "lon": round(d["exit"][1], 5),
            "node": rep, "edge": None, "t": None, "lines": sorted(lines), "note": " · ".join(notes),
            "nodes": d["nodes"], "approach": approach, "gate": f"node/{d['gate']}" if d["gate"] else None,
            "osm": d["host"].key, "_rg": gr.erg[rg_edge] if rg_edge is not None else None,
            "_host": d["host"], "_nodeset": set(d["nodes"]),
        })
    return items


def corridor_report(gr, tgrid, els):
    """율현터널(수서평택고속선)·GTX-A 터널 200m 안에서 받은 시설: 태그 패턴 개수와 이름 있는 것 목록."""
    pats = Counter()
    listed = []
    for e in els:
        t = e.get("tags", {})
        p = element_pt(e)
        if p is None:
            continue
        snaps = snap_tunnel(gr, tgrid, p, 250)
        line = None
        if snaps:
            j = snaps[0][1]
            line = gr.track_names[gr.etn[j]] or gr.label(gr.edge_lines(j))
        key = next((f"{k}={t[k]}" for k in ("man_made", "building", "landuse", "emergency", "entrance") if k in t), "name")
        pats[key] += 1
        if t.get("name") or t.get("man_made") in ("ventilation_shaft", "tower", "chimney"):
            listed.append({"osm": f"{e['type']}/{e['id']}", "tag": key, "name": t.get("name"),
                           "dist_m": round(snaps[0][0]) if snaps else None, "track": line})
    return {"elements": len(els), "patterns": dict(pats.most_common()), "named_or_tower": listed[:80]}


KIND_ORDER = {"portal": 0, "shaft": 1, "emergency_exit": 2, "depot": 3}
KEY_ORDER = ["k", "name", "lat", "lon", "node", "edge", "t", "lines", "note", "nodes", "also", "approach", "gate", "osm"]


def finish(gr, items, stats):
    regions = Regions()
    problems = []
    for it in items:
        rg = regions.of(it["lat"], it["lon"])
        if rg is None and it["_rg"] is not None:
            rg = gr.regions[it["_rg"]] + "(그래프 지역)"
        it["_sido"] = rg
        # 검사: 대한민국 안(시·도 다각형), 번호가 있는지
        if regions.of(it["lat"], it["lon"]) is None:
            problems.append(f"시·도 밖 좌표: {it['k']} {it['name']} {it['lat']},{it['lon']}")
        if not (33.0 <= it["lat"] <= 38.7 and 124.5 <= it["lon"] <= 131.0):
            problems.append(f"한국 범위 밖: {it['name']}")
        if it["node"] is not None and not (0 <= it["node"] < gr.n_nodes):
            problems.append(f"없는 노드: {it['name']} {it['node']}")
        if it["edge"] is not None:
            if not (0 <= it["edge"] < gr.n_edges) or gr.ek[it["edge"]] != 0:
                problems.append(f"없는 선로 간선: {it['name']} {it['edge']}")
            if not (0 <= it["t"] <= 1):
                problems.append(f"t 범위 밖: {it['name']} {it['t']}")
        for n in it.get("nodes") or ():
            if not (0 <= n < gr.n_nodes):
                problems.append(f"없는 노드(nodes): {it['name']} {n}")
        for j, t in it.get("also") or ():
            if not (0 <= j < gr.n_edges) or not (0 <= t <= 1):
                problems.append(f"없는 간선(also): {it['name']} {j}")
        for l in it["lines"]:
            if not (0 <= l < len(gr.lines)):
                problems.append(f"없는 노선: {it['name']} {l}")
        if it["node"] is not None and gr.comp[it["node"]] not in gr.station_comps:
            problems.append(f"역과 이어지지 않은 노드: {it['name']} {it['node']}")
    items.sort(key=lambda it: (KIND_ORDER[it["k"]], it["_sido"] or "", it["name"], it["lat"]))
    out_items = [{k: it[k] for k in KEY_ORDER if k in it} for it in items]
    data = {"format": "egress-1", "attribution": "© OpenStreetMap contributors (ODbL)", "osm_base": "2026-11-10",
            "items": out_items}
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with open(OUT, "wb") as f:
        f.write(raw)
    import gzip
    by_kind = Counter(it["k"] for it in items)
    by_region = defaultdict(Counter)
    for it in items:
        by_region[(it["_sido"] or "?").replace("(그래프 지역)", "*")][it["k"]] += 1
    stats["counts"] = dict(by_kind)
    stats["counts_by_sido"] = {r: dict(c) for r, c in sorted(by_region.items())}
    stats["depot_approach"] = dict(Counter(it.get("approach") for it in items if it["k"] == "depot"))
    stats["depot_with_gate"] = sum(1 for it in items if it["k"] == "depot" and it.get("gate"))
    stats["size_bytes"] = len(raw)
    stats["size_gzip_bytes"] = len(gzip.compress(raw, 9))
    stats["problems"] = problems
    stats["depots"] = [{"name": it["name"], "osm": it["osm"], "node": it["node"], "nodes": len(it["nodes"]),
                        "approach": it.get("approach"), "gate": it.get("gate"), "sido": it["_sido"], "note": it["note"]}
                       for it in items if it["k"] == "depot"]
    stats["shafts_and_exits"] = [{"k": it["k"], "name": it["name"], "osm": it["osm"], "edge": it["edge"], "t": it["t"],
                                  "sido": it["_sido"], "note": it["note"]}
                                 for it in items if it["k"] in ("shaft", "emergency_exit")]
    with open(OUT_REPORT, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)
    print("종류별:", json.dumps(stats["counts"], ensure_ascii=False))
    print("시·도별:")
    for r, c in stats["counts_by_sido"].items():
        print(f"  {r}: " + ", ".join(f"{k} {v}" for k, v in sorted(c.items(), key=lambda kv: KIND_ORDER[kv[0]])))
    print(f"기지 진입: {stats['depot_approach']}, 출입문 표시 있음 {stats['depot_with_gate']}")
    print(f"크기: {len(raw):,} byte (gzip {stats['size_gzip_bytes']:,})")
    print("문제:", len(problems))
    for p in problems[:20]:
        print("  ", p)
    # 표본 10개(종류마다 고르게)
    print("표본:")
    pick = []
    for k, n in (("portal", 4), ("shaft", 2), ("emergency_exit", 1), ("depot", 3)):
        pool = [it for it in items if it["k"] == k]
        step = max(1, len(pool) // n) if pool else 1
        pick += pool[::step][:n]
    for it in pick[:10]:
        print(f"  [{it['k']}] {it['name']} | {it['lat']},{it['lon']} | node {it['node']} edge {it['edge']} t {it['t']} "
              f"| OSM {it.get('osm')} | gate {it.get('gate')} | {it['_sido']} | {it['note']}")
    print("점검 결과:", os.path.relpath(OUT_REPORT, ROOT))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if "--fetch" in sys.argv:
        failed = fetch_missing()  # 서버가 안 되면 받은 것만으로 만든다(빠진 파일은 점검 결과에 남는다)
        if any(n.startswith("depots_") for n in failed):
            sys.exit("기지 원본을 다 받지 못해 도로 쿼리를 만들지 않는다. 나중에 --fetch 로 다시 실행할 것.")
    stats = {}
    t0 = time.time()
    gr = Graph()
    # 3. 차량기지(출입구를 거르는 데 쓰므로 먼저)
    depots = build_depots(gr, stats)
    if not os.path.exists(os.path.join(RAW, ROADS_FILE)) and "--fetch" in sys.argv:
        try:
            fetch_one(ROADS_FILE, depot_road_query(depots))
        except SystemExit as e:
            print("받기 중단:", e, flush=True)
    if "--fetch-only" in sys.argv:
        return
    depot_exits(gr, depots, stats)
    dep_items = depot_items(gr, depots, stats)
    print(f"차량기지 {len(dep_items)}개 ({time.time() - t0:.0f}s)", flush=True)
    # 1. 터널 출입구
    portals = build_portals(gr, stats)
    keep, dup = [], []
    for it in portals:
        host = None
        if it["_svc_only"]:
            p = (it["lat"], it["lon"])
            for d in dep_items:
                h = d["_host"]
                if it["node"] in d["_nodeset"] or (h.segs and (h.contains(p) or h.boundary_dist(p)[0] <= 100)):
                    host = d
                    break
        if host:
            dup.append({"portal": it["name"], "depot": host["name"], "node": it["node"]})
        else:
            keep.append(it)
    stats["portal_dropped_depot_duplicate"] = len(dup)
    stats["portal_dropped_examples"] = dup[:10]
    print(f"터널 출입구 {len(keep)}개 (기지 안 측선이라 뺀 것 {len(dup)}) ({time.time() - t0:.0f}s)", flush=True)
    # 2. 환기구·수직구·비상구
    tgrid = tunnel_index(gr)
    shafts, feats = build_shafts(gr, tgrid, stats)
    print(f"환기구·비상구 {len(shafts)}개 ({time.time() - t0:.0f}s)", flush=True)
    # 율현터널·GTX-A 회랑 확인
    corridor = load_opt("corridor_srt_gtxa.json", stats)
    stats["corridor_srt_gtxa"] = corridor_report(gr, tgrid, corridor)

    items = shafts + keep + dep_items
    finish(gr, items, stats)


if __name__ == "__main__":
    main()
