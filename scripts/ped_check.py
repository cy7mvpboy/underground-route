# ped_check.py
# 하는 일: 철도가 아닌 지하 보행로(지하상가·지하보도·역-건물 지하 연결)를 OSM에서 받아,
#          도시별 길이, 연결 덩어리(공유 노드 기준), 지하철 출입구·승강장과의 접점,
#          운영시간·출입 태그 비율, 알려진 장소 점검(spot-check) 결과를 계산한다.
# 사용법 (프로젝트 폴더에서):
#   python -I scripts\ped_check.py fetch <seoul|busan|daegu|incheon>   # Overpass에서 한 도시를 받는다(한 번에 하나)
#   python -I scripts\ped_check.py analyze                              # 받은 파일로 계산 -> data\derived\ped_check.json
# 입력: data\raw\ped\ped_<도시>.json, boundary_<도시>.json (fetch 결과),
#       data\raw\entrances.json, data\raw\stations.json
#       (data\raw\ped\around_spots.json 은 결과가 빈 장소를 손으로 확인하려고 한 번 받은 것이고, 여기서는 읽지 않는다.)
# 출력: data\derived\ped_check.json
# 판정: loose = tunnel/layer<0/level<0/location=underground 중 하나. strict = loose에서 layer<0만 근거인 way를 뺀 것.
#       결과 해석과 출처는 docs\ped-check.md에 있다.
# 원칙: Python 표준 라이브러리만 쓴다. Overpass 요청은 scripts\overpass_fetch.py의 fetch()를 그대로 쓴다.
import importlib.util
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw", "ped")
OUT = os.path.join(ROOT, "data", "derived", "ped_check.json")

# 도시 -> (시·도 경계의 ISO3166-2 코드, 받을 사각형 남,서,북,동)
# 시·도 경계(area) 안으로 거르는 쿼리는 서버가 502/504로 실패해서, 사각형으로 받고
# 시·도 경계 폴리곤(따로 받음)으로 Python에서 거른다. 인천은 본토만(먼 섬 제외).
CITIES = {
    "seoul": ("KR-11", (37.41, 126.76, 37.72, 127.19)),
    "busan": ("KR-26", (34.87, 128.75, 35.40, 129.32)),
    "daegu": ("KR-27", (35.60, 128.34, 36.33, 128.80)),
    "incheon": ("KR-28", (37.33, 126.35, 37.80, 126.80)),
}
CITY_KO = {"seoul": "서울", "busan": "부산", "daegu": "대구", "incheon": "인천"}

HW = "^(footway|corridor|steps|pedestrian|path|elevator)$"
NAME_RE = "지하상가|지하쇼핑|지하도상가|지하도 상가|지하 상가|지하보도|지하도|지하광장|지하통로|지하연결"

# 넓게 받고, 정확한 판정은 Python에서 한다.
QUERY = """[out:json][timeout:300][bbox:{bbox}];
(
  way[highway~"{hw}"][tunnel];
  way[highway~"{hw}"][layer~"^-"];
  way[highway~"{hw}"][level~"-|B"];
  way[highway~"{hw}"][location=underground];
  way[indoor~"^(corridor|area|room)$"][level~"-|B"];
  way[indoor~"^(corridor|area|room)$"][layer~"^-"];
  nwr[shop=mall];
  nwr[name~"{name}"];
  way[railway=platform];
);
out body geom;
"""

# 시·도 경계 폴리곤(바깥 테두리 way들의 좌표)
BOUNDARY_QUERY = """[out:json][timeout:180];
rel["ISO3166-2"="{iso}"][boundary=administrative];
out geom;
"""


# ---------------------------------------------------------------- 받기
def load_overpass_fetch():
    """-I 모드에서는 scripts 폴더가 sys.path에 없으므로 파일 경로로 직접 불러온다."""
    path = os.path.join(ROOT, "scripts", "overpass_fetch.py")
    spec = importlib.util.spec_from_file_location("overpass_fetch", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def cmd_fetch(city, what="ped"):
    """what: ped(보행로·상가·승강장) 또는 boundary(시·도 경계)."""
    os.makedirs(RAW, exist_ok=True)
    iso, bbox = CITIES[city]
    if what == "boundary":
        q = BOUNDARY_QUERY.format(iso=iso)
    else:
        q = QUERY.format(bbox=",".join(str(v) for v in bbox), hw=HW, name=NAME_RE)
    with open(os.path.join(RAW, f"{what}_{city}.overpassql"), "w", encoding="utf-8") as f:
        f.write(q)
    ok = load_overpass_fetch().fetch(q, os.path.join(RAW, f"{what}_{city}.json"))
    return 0 if ok else 1


# ---------------------------------------------------------------- 공통 도구
def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class Proj:
    """좁은 지역용 평면 좌표(m). 도시 하나 안에서는 오차가 무시할 만하다."""

    def __init__(self, lat0):
        self.kx = 111320.0 * math.cos(math.radians(lat0))
        self.ky = 110540.0

    def xy(self, lat, lon):
        return lon * self.kx, lat * self.ky


def seg_dist(p, a, b):
    """점 p와 선분 ab 사이 거리(평면 좌표)."""
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def haversine(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def way_len(geom):
    return sum(haversine(geom[i]["lat"], geom[i]["lon"], geom[i + 1]["lat"], geom[i + 1]["lon"])
               for i in range(len(geom) - 1))


class Boundary:
    """시·도 경계 relation의 outer/inner way 선분 전체로 짝홀(even-odd) 판정을 한다.
    고리(ring)를 조립하지 않아도 선분들이 닫힌 고리들을 이루면 결과가 같다."""

    def __init__(self, path):
        segs = []
        for e in load_json(path)["elements"]:
            if e["type"] != "relation":
                continue
            for m in e.get("members", []):
                if m["type"] == "way" and m.get("role") in ("outer", "inner") and "geometry" in m:
                    g = [(p["lat"], p["lon"]) for p in m["geometry"] if p]
                    segs += list(zip(g, g[1:]))
        self.segs = segs

    def contains(self, lat, lon):
        inside = False
        for (la1, lo1), (la2, lo2) in self.segs:
            if (la1 > lat) != (la2 > lat):
                x = lo1 + (lat - la1) * (lo2 - lo1) / (la2 - la1)
                if x > lon:
                    inside = not inside
        return inside


def norm_name(s):
    """역 이름 정규화: 괄호 내용·공백·끝의 '역' 제거."""
    s = re.sub(r"\(.*?\)", "", s or "")
    s = s.replace(" ", "")
    return s[:-1] if s.endswith("역") and len(s) > 1 else s


def is_neg_level(v):
    """level 값에 음수 층이 하나라도 있으면 True. 예: -1, -1;0, 0;-1, B1, -3-9(범위)."""
    if not v:
        return False
    for tok in v.split(";"):
        tok = tok.strip()
        if re.match(r"^-\d", tok) or re.match(r"^[Bb]\d", tok):
            return True
    return False


def is_neg_layer(v):
    try:
        return float((v or "").split(";")[0]) < 0
    except ValueError:
        return False


HW_SET = {"footway", "corridor", "steps", "pedestrian", "path", "elevator"}


def classify(tags):
    """보행 way의 지하 근거(패턴) 목록과, 따로 셀 building_passage 여부를 돌려준다."""
    pats = []
    t = tags.get("tunnel")
    if t == "building_passage":
        return ["tunnel=building_passage"], True
    if t and t not in ("no", "culvert"):
        pats.append(f"tunnel={t}")
    if is_neg_layer(tags.get("layer")):
        pats.append("layer<0")
    if is_neg_level(tags.get("level")):
        pats.append("level<0")
    if tags.get("location") == "underground":
        pats.append("location=underground")
    if tags.get("indoor") in ("corridor", "area", "room", "yes") and pats:
        pats.append(f"indoor={tags['indoor']}")
    return pats, False


class Grid:
    """선분·점을 100m 칸에 넣어 가까운 것만 찾는다."""

    def __init__(self, cell=100.0):
        self.cell = cell
        self.cells = defaultdict(list)

    def key(self, x, y):
        return int(x // self.cell), int(y // self.cell)

    def add_seg(self, a, b, item):
        x0, x1 = sorted((a[0], b[0]))
        y0, y1 = sorted((a[1], b[1]))
        for i in range(int(x0 // self.cell), int(x1 // self.cell) + 1):
            for j in range(int(y0 // self.cell), int(y1 // self.cell) + 1):
                self.cells[(i, j)].append((a, b, item))

    def near(self, p, r):
        ci, cj = self.key(*p)
        n = int(r // self.cell) + 1
        for i in range(ci - n, ci + n + 1):
            for j in range(cj - n, cj + n + 1):
                yield from self.cells.get((i, j), ())


# ---------------------------------------------------------------- 역·출입구
def load_stations_entrances():
    stations = []  # (정규화 이름, lat, lon)
    for e in load_json(os.path.join(ROOT, "data", "raw", "stations.json"))["elements"]:
        t = e.get("tags", {})
        lat = e.get("lat", e.get("center", {}).get("lat"))
        lon = e.get("lon", e.get("center", {}).get("lon"))
        if lat is None or not t.get("name"):
            continue
        names = {norm_name(t["name"])}
        for k in ("alt_name", "old_name", "official_name", "name:ko"):
            if t.get(k):
                names |= {norm_name(x) for x in t[k].split(";")}
        stations.append((names, norm_name(t["name"]), lat, lon))
    entrances = []  # (id, lat, lon, 역 이름 또는 None)
    for e in load_json(os.path.join(ROOT, "data", "raw", "entrances.json"))["elements"]:
        t = e.get("tags", {})
        m = re.match(r"^\s*(.+?)역", t.get("description", "") or t.get("name", ""))
        entrances.append((e["id"], e["lat"], e["lon"], norm_name(m.group(1)) if m else None))
    return stations, entrances


def entrance_station(ent, stations):
    """출입구 -> 역 이름. 설명 태그의 역 이름을 먼저 쓰고, 없으면 300m 안의 가장 가까운 역."""
    _id, lat, lon, nm = ent
    best, bd = None, 300.0
    for names, main, slat, slon in stations:
        if abs(slat - lat) > 0.004 or abs(slon - lon) > 0.005:
            continue
        d = haversine(lat, lon, slat, slon)
        if nm and nm in names and d < 600:
            return main
        if d < bd:
            best, bd = main, d
    return nm or best


# ---------------------------------------------------------------- 알려진 장소(spot-check) 정의
# expect: 공개 자료로 확인한, 지하 보행로로 이어진다고 알려진 역들. 출처는 docs\ped-check.md에 적는다.
SPOTS = [
    {"id": "euljiro", "city": "seoul", "name": "을지로 지하상가(시청~동대문역사문화공원 지하보도 2.8km)",
     "expect": ["시청", "을지로입구", "을지로3가", "을지로4가", "동대문역사문화공원"]},
    {"id": "jonggak", "city": "seoul", "name": "종각 지하쇼핑센터(종각역 9~12번 출구)",
     "expect": ["종각"]},
    {"id": "jongno4", "city": "seoul", "name": "종로4가·종오 지하상가(종로3가~종로5가 일대)",
     "expect": ["종로3가", "종로5가"]},
    {"id": "myeongdong", "city": "seoul", "name": "명동 지하쇼핑센터(을지로입구역 7번 출구)·명동역 지하상가",
     "expect": ["을지로입구", "명동"]},
    {"id": "gangnam", "city": "seoul", "name": "강남역 지하쇼핑센터",
     "expect": ["강남"], "extra": ["신논현"]},
    {"id": "terminal", "city": "seoul", "name": "고속터미널 지하쇼핑센터(고투몰)",
     "expect": ["고속터미널"]},
    {"id": "yeongdeungpo", "city": "seoul", "name": "영등포역·영등포로터리·영등포시장 지하상가",
     "expect": ["영등포", "영등포시장"]},
    {"id": "coex", "city": "seoul", "name": "삼성역~코엑스몰~봉은사역",
     "expect": ["삼성", "봉은사"]},
    {"id": "seomyeon", "city": "busan", "name": "서면 지하상가(서면몰·부전몰·중앙몰)",
     "expect": ["서면", "부전"]},
    {"id": "nampo", "city": "busan", "name": "남포·광복 지하상가(자갈치~남포~중앙)",
     "expect": ["자갈치", "남포", "중앙"]},
    {"id": "busan_station", "city": "busan", "name": "부산역 지하상가·1호선~KTX 연결통로",
     "expect": ["부산"]},
]


# ---------------------------------------------------------------- 분석
def analyze_city(city, stations, entrances):
    ped_path = os.path.join(RAW, f"ped_{city}.json")
    bnd_path = os.path.join(RAW, f"boundary_{city}.json")
    if not (os.path.exists(ped_path) and os.path.exists(bnd_path)):
        return None
    data = load_json(ped_path)
    bnd = Boundary(bnd_path)
    s, w, n, e = CITIES[city][1]
    proj = Proj((s + n) / 2)

    ug_ways, bp_ways, platforms, malls, indoor_areas = [], [], [], [], []
    for el in data["elements"]:
        t = el.get("tags", {})
        if el["type"] == "way" and "geometry" in el:
            g = el["geometry"]
            mid = g[len(g) // 2]
            if not bnd.contains(mid["lat"], mid["lon"]):
                continue
            if t.get("highway") in HW_SET:
                pats, is_bp = classify(t)
                rec = {"id": el["id"], "tags": t, "nodes": el["nodes"], "geom": g,
                       "len": way_len(g), "pats": pats}
                if is_bp:
                    bp_ways.append(rec)
                elif pats:
                    ug_ways.append(rec)
                continue
            if t.get("railway") == "platform":
                platforms.append(el)
                continue
            if t.get("indoor") in ("corridor", "area", "room") and (
                    is_neg_level(t.get("level")) or is_neg_layer(t.get("layer"))):
                indoor_areas.append(el)
        if t.get("shop") == "mall" or re.search(NAME_RE, t.get("name", "")):
            if t.get("highway") and t["highway"] not in HW_SET:
                continue  # 이름에 '지하도'가 든 차도 등
            if el["type"] == "node":
                lat, lon = el["lat"], el["lon"]
            elif el["type"] == "way" and "geometry" in el:
                lat = sum(p["lat"] for p in el["geometry"]) / len(el["geometry"])
                lon = sum(p["lon"] for p in el["geometry"]) / len(el["geometry"])
            elif "bounds" in el:
                b = el["bounds"]
                lat, lon = (b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2
            else:
                continue
            if bnd.contains(lat, lon):
                malls.append({"type": el["type"], "id": el["id"], "name": t.get("name", ""),
                              "lat": round(lat, 6), "lon": round(lon, 6),
                              "level": t.get("level"), "layer": t.get("layer"),
                              "opening_hours": t.get("opening_hours"), "shop": t.get("shop"),
                              "indoor": t.get("indoor"), "highway": t.get("highway")})

    # --- 태그 패턴별 길이
    pat_km, combo_km, hw_km = Counter(), Counter(), Counter()
    level_vals, tunnel_vals = Counter(), Counter()
    for r in ug_ways:
        for p in r["pats"]:
            pat_km[p] += r["len"]
        combo_km[" + ".join(r["pats"])] += r["len"]
        hw_km[r["tags"]["highway"]] += r["len"]
        if r["tags"].get("level"):
            level_vals[r["tags"]["level"]] += 1
        tunnel_vals[r["tags"].get("tunnel")] += 1
    total_ug = sum(r["len"] for r in ug_ways)

    # --- 운영시간·출입 태그
    oh_n = sum(1 for r in ug_ways if r["tags"].get("opening_hours"))
    oh_len = sum(r["len"] for r in ug_ways if r["tags"].get("opening_hours"))
    access_vals = Counter(r["tags"].get("access") for r in ug_ways if r["tags"].get("access"))
    foot_vals = Counter(r["tags"].get("foot") for r in ug_ways if r["tags"].get("foot"))
    oh_examples = [{"id": r["id"], "name": r["tags"].get("name", ""), "opening_hours": r["tags"]["opening_hours"]}
                   for r in ug_ways if r["tags"].get("opening_hours")][:10]

    # 출입구·승강장·역 색인
    ent_ids = {}
    ent_grid = Grid()
    for ent in entrances:
        if s - 0.01 <= ent[1] <= n + 0.01 and w - 0.01 <= ent[2] <= e + 0.01:
            ent_ids[ent[0]] = ent
            p = proj.xy(ent[1], ent[2])
            ent_grid.add_seg(p, p, ent)
    plat_nodes = set()
    for pl in platforms:
        plat_nodes.update(pl.get("nodes", []))
    city_st = [st for st in stations if s <= st[2] <= n and w <= st[3] <= e]
    ent_station_cache = {}

    def ent_st(ent):
        if ent[0] not in ent_station_cache:
            ent_station_cache[ent[0]] = entrance_station(ent, city_st)
        return ent_station_cache[ent[0]]

    comp_loose = build_components(ug_ways, city, proj, ent_ids, ent_grid, plat_nodes, city_st, ent_st)
    # strict: layer<0 하나만 근거인 way를 뺀다(청계천 산책로처럼 지상이 열린 곳이 많다).
    strict_ways = [r for r in ug_ways if r["pats"] != ["layer<0"]]
    comp_strict = build_components(strict_ways, city + "-s", proj, ent_ids, ent_grid, plat_nodes, city_st, ent_st)

    def stats(comp_list):
        def stat(pred):
            cs = [c for c in comp_list if pred(c)]
            return {"n": len(cs), "km": round(sum(c["length_m"] for c in cs) / 1000, 2)}

        touch = lambda c: c["shares_entrance_node"] > 0 or c["entrances_within_50m"] > 0
        return {
            "all": stat(lambda c: True),
            "len_ge_100m": stat(lambda c: c["length_m"] >= 100),
            "len_ge_500m": stat(lambda c: c["length_m"] >= 500),
            "len_ge_1km": stat(lambda c: c["length_m"] >= 1000),
            "shares_entrance_node": stat(lambda c: c["shares_entrance_node"] > 0),
            "entrance_shared_or_within_50m": stat(touch),
            "shares_platform_node": stat(lambda c: c["shares_platform_node"]),
            "touch_entrance_or_platform": stat(lambda c: touch(c) or c["shares_platform_node"]),
            "links_2plus_stations_via_entrances": stat(lambda c: len(c["stations_via_entrances"]) >= 2),
            "links_2plus_stations_entr_or_150m": stat(
                lambda c: len(set(c["stations_via_entrances"]) | set(c["stations_within_150m"])) >= 2),
        }

    summary = {
        "osm_base": data["osm3s"]["timestamp_osm_base"],
        "ug_ways": len(ug_ways), "ug_km": round(total_ug / 1000, 2),
        "strict_ways": len(strict_ways), "strict_km": round(sum(r["len"] for r in strict_ways) / 1000, 2),
        "building_passage": {"ways": len(bp_ways), "km": round(sum(r["len"] for r in bp_ways) / 1000, 2)},
        "km_by_pattern": {k: round(v / 1000, 2) for k, v in pat_km.most_common()},
        "km_by_pattern_combo": {k: round(v / 1000, 2) for k, v in combo_km.most_common()},
        "km_by_highway": {k: round(v / 1000, 2) for k, v in hw_km.most_common()},
        "tunnel_values": {str(k): v for k, v in tunnel_vals.most_common()},
        "level_values_top": dict(level_vals.most_common(15)),
        "components_loose": stats(comp_loose),
        "components_strict": stats(comp_strict),
        "opening_hours": {"ways": oh_n, "km": round(oh_len / 1000, 2), "examples": oh_examples},
        "access_values": dict(access_vals), "foot_values": dict(foot_vals),
        "malls_and_named_arcades": malls,
        "indoor_areas_negative_level": len(indoor_areas),
        "platform_ways": len(platforms),
    }
    return summary, comp_loose, comp_strict


def build_components(ug_ways, prefix, proj, ent_ids, ent_grid, plat_nodes, city_st, ent_st):
    """공유 노드로 이어진 way들을 한 덩어리로 묶고(union-find), 덩어리마다 접점 정보를 센다."""
    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for r in ug_ways:
        ns = r["nodes"]
        for a in ns[1:]:
            ra, rb = find(ns[0]), find(a)
            if ra != rb:
                parent[ra] = rb
    comps = defaultdict(list)
    for r in ug_ways:
        comps[find(r["nodes"][0])].append(r)

    comp_list = []
    for root, ways in comps.items():
        nodes = set()
        segs = []
        for r in ways:
            nodes.update(r["nodes"])
            pts = [proj.xy(p["lat"], p["lon"]) for p in r["geom"]]
            segs += list(zip(pts, pts[1:]))
        length = sum(r["len"] for r in ways)
        shared_ent = [ent_ids[x] for x in nodes if x in ent_ids]
        # 50m 안의 출입구(선분까지 거리)
        near_ent = {}
        seg_grid = Grid()
        for a, b in segs:
            seg_grid.add_seg(a, b, None)
        cand = set()
        for a, b in segs:
            for _, _, ent in ent_grid.near(a, 60):
                cand.add(ent)
            for _, _, ent in ent_grid.near(b, 60):
                cand.add(ent)
        for ent in cand:
            p = proj.xy(ent[1], ent[2])
            d = min(seg_dist(p, a, b) for a, b, _ in seg_grid.near(p, 60))
            if d <= 50:
                near_ent[ent[0]] = (ent, d)
        touched = sorted({ent_st(x[0]) for x in near_ent.values() if ent_st(x[0])})
        all_pts = [(p["lat"], p["lon"]) for r in ways for p in r["geom"]]
        clat = sum(p[0] for p in all_pts) / len(all_pts)
        clon = sum(p[1] for p in all_pts) / len(all_pts)
        # 역 노드 150m 안(역 노드는 보통 역 중심 위)
        st_near = set()
        for names, main, slat, slon in city_st:
            if abs(slat - clat) > 0.05 or abs(slon - clon) > 0.06:
                continue
            sp = proj.xy(slat, slon)
            if any(seg_dist(sp, a, b) <= 150 for a, b, _ in seg_grid.near(sp, 150)):
                st_near.add(main)
        names = Counter()
        for r in ways:
            if r["tags"].get("name"):
                names[r["tags"]["name"]] += r["len"]
        nearest = min(city_st, key=lambda st: haversine(clat, clon, st[2], st[3])) if city_st else None
        comp_list.append({
            "length_m": round(length, 1), "n_ways": len(ways),
            "center": [round(clat, 6), round(clon, 6)],
            "nearest_station": nearest[1] if nearest else None,
            "nearest_station_m": round(haversine(clat, clon, nearest[2], nearest[3])) if nearest else None,
            "names": [k for k, _ in names.most_common(4)],
            "highway": dict(Counter(r["tags"]["highway"] for r in ways)),
            "shares_entrance_node": len(shared_ent),
            "entrances_within_50m": len(near_ent),
            "stations_via_entrances": touched,
            "stations_within_150m": sorted(st_near),
            "shares_platform_node": bool(nodes & plat_nodes),
            "with_opening_hours": sum(1 for r in ways if r["tags"].get("opening_hours")),
            "layer_only_m": round(sum(r["len"] for r in ways if r["pats"] == ["layer<0"]), 1),
            "way_ids": [r["id"] for r in sorted(ways, key=lambda r: -r["len"])],
            "_pts": [(p["lat"], p["lon"]) for r in ways for p in r["geom"]],  # 저장하지 않음
        })
    comp_list.sort(key=lambda c: -c["length_m"])
    for i, c in enumerate(comp_list):
        c["cid"] = f"{prefix}-{i}"
    return comp_list


def spot_check(spot, comp_list, stations, city_bbox):
    s, w, n, e = city_bbox
    city_st = [st for st in stations if s <= st[2] <= n and w <= st[3] <= e]
    res = {"id": spot["id"], "name": spot["name"], "expect": spot["expect"]}
    want = spot["expect"] + spot.get("extra", [])
    found = {}
    for nm in want:
        nodes = [st for st in city_st if nm in st[0]]
        found[nm] = len(nodes)
    res["station_nodes_found"] = found
    want_pts = [(st[2], st[3]) for st in city_st if set(want) & st[0]]
    # 예상 역 중 하나라도 닿는(출입구 50m 또는 역 노드 150m) 덩어리
    rel = []
    near = []  # 닿지는 않지만 예상 역 400m 안에 있는 덩어리(끊긴 상가 등)
    for c in comp_list:
        hit = sorted(set(want) & (set(c["stations_via_entrances"]) | set(c["stations_within_150m"])))
        if hit:
            rel.append((c, hit))
        elif c["length_m"] >= 30 and want_pts:
            d = min(haversine(a, b, la, lo) for a, b in c["_pts"] for la, lo in want_pts)
            if d <= 400:
                near.append((c, round(d)))
    rel.sort(key=lambda x: -x[0]["length_m"])
    near.sort(key=lambda x: -x[0]["length_m"])
    res["components"] = [{"cid": c["cid"], "length_m": c["length_m"], "touches": hit,
                          "via_entrances": c["stations_via_entrances"], "names": c["names"],
                          "layer_only_m": c["layer_only_m"], "way_ids": c["way_ids"][:8]} for c, hit in rel[:6]]
    res["nearby_untouched_components"] = [
        {"cid": c["cid"], "length_m": c["length_m"], "dist_to_station_m": d, "names": c["names"],
         "entrances_within_50m": c["entrances_within_50m"], "way_ids": c["way_ids"][:8]} for c, d in near[:6]]
    covered = set()
    best = []
    for c, hit in rel:
        covered |= set(hit)
        if len(hit) > len(best):
            best = hit
    res["expect_touched"] = sorted(covered & set(spot["expect"]))
    res["max_expected_in_one_component"] = sorted(set(best) & set(spot["expect"]))
    res["ug_km_touching"] = round(sum(c["length_m"] for c, _ in rel) / 1000, 2)
    return res


def cmd_analyze():
    stations, entrances = load_stations_entrances()
    out = {"generated_by": "scripts/ped_check.py",
           "note": "loose = tunnel/layer<0/level<0/location=underground 중 하나라도 있는 보행 way. "
                   "strict = loose에서 layer<0만 근거인 way를 뺀 것. building_passage는 따로 셈.",
           "cities": {}, "top_components_loose": {}, "top_components_strict": {}, "spot_checks": []}
    comps_by_city = {}
    for city in CITIES:
        r = analyze_city(city, stations, entrances)
        if r is None:
            print(f"{city}: 원본 없음, 건너뜀")
            continue
        summary, loose, strict = r
        out["cities"][city] = summary
        comps_by_city[city] = loose
        strip = lambda cs: [{k: v for k, v in c.items() if k != "_pts"} for c in cs[:25]]
        out["top_components_loose"][city] = strip(loose)
        out["top_components_strict"][city] = strip(strict)
        for label, c in (("loose", summary["components_loose"]), ("strict", summary["components_strict"])):
            print(f"{CITY_KO[city]} {label}: 덩어리 {c['all']}, 1km+ {c['len_ge_1km']}, "
                  f"출입구 접촉 {c['entrance_shared_or_within_50m']}, 역2+ {c['links_2plus_stations_entr_or_150m']}")
        print(f"   way {summary['ug_ways']}개 {summary['ug_km']}km (strict {summary['strict_km']}km), "
              f"building_passage {summary['building_passage']}, 운영시간 {summary['opening_hours']['ways']}")
    for spot in SPOTS:
        if spot["city"] in comps_by_city:
            sc = spot_check(spot, comps_by_city[spot["city"]], stations, CITIES[spot["city"]][1])
            out["spot_checks"].append(sc)
            print(f"  [{spot['id']}] 닿는 역 {sc['expect_touched']} / 한 덩어리 최대 {sc['max_expected_in_one_component']}"
                  f" / {sc['ug_km_touching']}km / " +
                  ", ".join(f"{x['cid']}:{x['length_m']:.0f}m{x['touches']}" for x in sc["components"][:4]) +
                  " / 근처: " + ", ".join(f"{x['cid']}:{x['length_m']:.0f}m@{x['dist_to_station_m']}m{x['names'][:1]}"
                                          for x in sc["nearby_untouched_components"][:3]))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("저장:", OUT)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) >= 3 and sys.argv[1] == "fetch":
        sys.exit(cmd_fetch(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "ped"))
    if len(sys.argv) >= 2 and sys.argv[1] == "analyze":
        sys.exit(cmd_analyze())
    print("사용법: python -I scripts\\ped_check.py fetch <도시> [ped|boundary] | analyze")
