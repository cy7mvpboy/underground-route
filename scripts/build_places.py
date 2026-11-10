# build_places.py
# 하는 일: 오프라인 장소 검색 색인 web\data\places.json 을 만든다(형식: docs\graph-format.md 'places.json' 절).
#   - 행정구역(시·도, 시·군·구, 읍·면·동, 리), 역, 공공시설(병원·학교·대학·관공서·경찰·소방·도서관),
#     아파트·주거단지, 명소(관광지·박물관·백화점·쇼핑몰)의 이름과 대표 좌표, 소속 지역 문자열.
#   - 소속 지역(예: '경기도 수원시 장안구')은 시·군·구(admin_level 6/7) 경계 안에 점이 드는지로 정한다.
# 사용법(프로젝트 폴더에서):
#   python -I scripts\build_places.py --fetch   원본이 없으면 Overpass 로 받는다(한 번에 하나씩) → 그리고 만든다
#   python -I scripts\build_places.py           data\raw\places\ 의 원본으로 만들기만 한다
# 원본: data\raw\places\*.json (Overpass 응답 그대로). 시·도 경계는 data\raw\basemap\admin.json, 역은 web\data\graph.json 을 읽기만 한다.
# 원칙: Python 표준 라이브러리만 쓴다. Overpass 요청은 scripts\overpass_fetch.py 의 fetch() 를 그대로 쓴다.
import gzip
import json
import math
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw", "places")
OUT = os.path.join(ROOT, "web", "data", "places.json")
ADMIN4 = os.path.join(ROOT, "data", "raw", "basemap", "admin.json")
GRAPH = os.path.join(ROOT, "web", "data", "graph.json")

KR = 'area["ISO3166-1"="KR"][admin_level=2]->.kr;\n'
HEAD = "[out:json][timeout:900];\n"

# 받을 원본: (파일 이름, Overpass QL). 전국 한 번에 받으면 시간 초과가 나는 아파트 건물은 4조각으로 나눈다.
APT_TILES = [(37.4, 124.5, 38.7, 127.0), (37.0, 124.5, 37.4, 127.0),
             (37.4, 127.0, 38.7, 131.0), (37.0, 127.0, 37.4, 131.0),
             (35.5, 124.5, 37.0, 131.0), (33.0, 124.5, 35.5, 131.0)]
QUERIES = [
    ("admin67.json", HEAD + KR +
     '// 시·군·구(6)·일반구(7) 경계. 점이 어느 시·군·구에 드는지 정하는 데 쓴다.\n'
     'rel(area.kr)[boundary=administrative][admin_level~"^(6|7)$"];\nout geom;'),
    ("admin8.json", HEAD + KR +
     '// 읍·면·동(행정동) relation 이름과 중심\n'
     'rel(area.kr)[boundary=administrative][admin_level=8];\nout center tags;'),
    ("place_nodes.json", HEAD + KR +
     '// 동·읍·면·리 이름 점(place=*). 법정동 이름(예: 역삼동)이 여기서 온다.\n'
     'node(area.kr)[place~"^(suburb|quarter|neighbourhood|town|village)$"][name];\nout;'),
    ("pois_amenity.json", HEAD + KR +
     '// 공공시설\n'
     'nwr(area.kr)[amenity~"^(hospital|school|university|college|townhall|police|fire_station|library)$"][name];\n'
     'out center tags;'),
    ("pois_landmark.json", HEAD + KR +
     '// 명소·큰 상업시설\n'
     '(nwr(area.kr)[tourism~"^(attraction|museum|theme_park)$"][name];\n'
     ' nwr(area.kr)[shop~"^(mall|department_store)$"][name];);\nout center tags;'),
    ("residential.json", HEAD + KR +
     '// 이름 있는 주거단지(대개 아파트 단지 경계)\n'
     'wr(area.kr)[landuse=residential][name];\nout center tags;'),
    ("pois_extra.json", HEAD + KR +
     '// 보충: amenity=townhall 이 아닌 구청·시청(office=government), 궁궐·성문, 경기장\n'
     '(nwr(area.kr)[office=government][name];\n'
     ' nwr(area.kr)[historic~"^(castle|city_gate|palace)$"][name];\n'
     ' nwr(area.kr)[leisure=stadium][name];);\nout center tags;'),
] + [
    # 영역 필터(area.kr)를 걸면 너무 느려서 상자로만 자른다. 북한·바다 점은 만들 때 시·도 경계로 거른다.
    (f"apartments_{i}.json", HEAD +
     f'// 이름 있는 아파트 건물, 조각 {i} (남,서,북,동)={t}\n'
     f'wr({t[0]},{t[1]},{t[2]},{t[3]})[building=apartments][name];\nout center tags;')
    for i, t in enumerate(APT_TILES)
]

TYPES = ["sido", "sigungu", "dong", "village", "station", "hospital", "university", "school",
         "gov", "police", "fire", "library", "apartment", "landmark"]
T = {n: i for i, n in enumerate(TYPES)}
AMENITY_TYPE = {"hospital": "hospital", "school": "school", "university": "university", "college": "university",
                "townhall": "gov", "police": "police", "fire_station": "fire", "library": "library"}
# 크기가 넘치면 이 순서로 뺀다(가치가 낮은 것부터)
# 아파트 묶음: A = 이름에 '아파트·단지'가 든 주거단지 경계, 또는 건물 5동 이상 단지
#              B = 그 밖의 이름 있는 주거단지 경계(빌라·연립·마을 등도 섞임)
#              C = 건물 2~4동으로만 아는 단지, D = 건물 1동뿐(빌라·오피스텔이 많다)
# 크기가 넘치면 이 순서로 뺀다. 마지막으로 빼는 묶음은 일부만 뺀다(아파트는 건물이 적은 단지부터).
CUT_ORDER = ["village", "library", "apartment_D", "apartment_C", "apartment_B", "fire", "police",
             "apartment_A", "landmark"]
APT_WORD = re.compile(r"아파트|단지|APT|apt|Apt")
GOV_NAME = re.compile(r"(시청|구청|군청|도청|청사|주민센터|행정복지센터|사무소)$")
SIZE_LIMIT = 3_000_000
DEDUP_M = 200      # 같은 이름·같은 종류 점을 하나로 합치는 거리
APT_CLUSTER_M = 400  # 같은 이름 아파트 건물들을 한 단지로 묶는 거리


# ---------- 받기 ----------
def fetch_missing():
    sys.path.insert(0, os.path.join(ROOT, "scripts"))  # -I 모드에서도 옆 스크립트를 불러오기 위해
    import overpass_fetch
    os.makedirs(RAW, exist_ok=True)
    for name, q in QUERIES:
        path = os.path.join(RAW, name)
        if os.path.exists(path):
            continue
        print("받기:", name, flush=True)
        if not overpass_fetch.fetch(q, path):
            sys.exit(f"받기 실패: {name}")
        time.sleep(5)  # 다음 요청 전에 잠깐 쉰다


def load(name):
    with open(os.path.join(RAW, name), encoding="utf-8") as f:
        d = json.load(f)
    if d.get("remark"):
        sys.exit(f"{name}: Overpass remark(시간 초과 등) — 다시 받아야 함: {d['remark'][:200]}")
    return d["elements"]


# ---------- 이름 정규화(web\js\places.js 의 normalize 와 같은 규칙) ----------
_PAREN = re.compile(r"\([^)]*\)|\[[^\]]*\]")
_NONWORD = re.compile(r"[^0-9a-z가-힣ㄱ-ㆎ]")


def norm(s):
    k = _NONWORD.sub("", _PAREN.sub("", (s or "").lower()))
    if len(k) >= 3 and k.endswith("역"):
        k = k[:-1]
    return k


def clean_name(s):
    return re.sub(r"\s+", " ", (s or "").strip())


# ---------- 점이 다각형 안에 드는지(짝수-홀수 규칙, 위도 띠 색인) ----------
BAND = 50  # 위도 0.02도 띠


class Poly:
    def __init__(self, rel):
        self.id = rel["id"]
        self.tags = rel.get("tags", {})
        self.name = self.tags.get("name", "")
        self.level = self.tags.get("admin_level", "")
        self.bands = {}
        la0 = lo0 = 999.0
        la1 = lo1 = -999.0
        self.rep = None
        for m in rel.get("members", []):
            if m["type"] == "node" and m.get("role") in ("label", "admin_centre") and "lat" in m:
                if self.rep is None or m["role"] == "label":
                    self.rep = (m["lat"], m["lon"])
            if m["type"] != "way" or m.get("role") not in ("outer", "inner", ""):
                continue
            g = [p for p in (m.get("geometry") or []) if p]
            for a, b in zip(g, g[1:]):
                y1, x1, y2, x2 = a["lat"], a["lon"], b["lat"], b["lon"]
                if y1 == y2:
                    continue
                for k in range(int(min(y1, y2) * BAND), int(max(y1, y2) * BAND) + 1):
                    self.bands.setdefault(k, []).append((y1, x1, y2, x2))
                la0, la1 = min(la0, y1, y2), max(la1, y1, y2)
                lo0, lo1 = min(lo0, x1, x2), max(lo1, x1, x2)
        self.bbox = (la0, lo0, la1, lo1)
        if self.rep is None:
            self.rep = ((la0 + la1) / 2, (lo0 + lo1) / 2)

    def contains(self, lat, lon):
        b = self.bbox
        if not (b[0] <= lat <= b[2] and b[1] <= lon <= b[3]):
            return False
        inside = False
        for y1, x1, y2, x2 in self.bands.get(int(lat * BAND), ()):
            if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
        return inside


def first_inside(polys, lat, lon):
    for p in polys:
        if p.contains(lat, lon):
            return p
    return None


def dist_m(a, b):
    x = (b[1] - a[1]) * math.cos(math.radians((a[0] + b[0]) / 2)) * 111320
    y = (b[0] - a[0]) * 110570
    return math.hypot(x, y)


# ---------- 지역 표 ----------
class Areas:
    """시·도(4), 시·군·구(6), 일반구(7) 다각형으로 점의 소속 지역 문자열을 정한다."""

    def __init__(self):
        with open(ADMIN4, encoding="utf-8") as f:
            a4 = [e for e in json.load(f)["elements"] if e["type"] == "relation"]
        self.l4 = [Poly(r) for r in a4]
        rels = [e for e in load("admin67.json") if e["type"] == "relation"]
        polys = [Poly(r) for r in rels]
        self.l6 = [p for p in polys if p.level == "6"]
        self.l7 = [p for p in polys if p.level == "7"]
        self.label = {}   # 다각형 id → 지역 문자열(그 다각형까지 포함)
        self.parent = {}  # 다각형 id → 상위 지역 문자열(시·군·구 항목의 area 로 쓴다)
        self.dropped = []
        for p in self.l6:
            s = self.sido_of(*p.rep)
            if s is None:
                self.dropped.append(p.name)
                continue
            self.parent[p.id] = s.name
            self.label[p.id] = f"{s.name} {p.name}"
        self.l6 = [p for p in self.l6 if p.id in self.label]
        for p in self.l7:
            up = first_inside(self.l6, *p.rep)
            if up is None:
                s = self.sido_of(*p.rep)
                if s is None:
                    self.dropped.append(p.name)
                    continue
                self.parent[p.id] = s.name
            else:
                self.parent[p.id] = self.label[up.id]
            self.label[p.id] = f"{self.parent[p.id]} {p.name}"
        self.l7 = [p for p in self.l7 if p.id in self.label]

    def sido_of(self, lat, lon):
        return first_inside(self.l4, lat, lon)

    def of(self, lat, lon):
        """점의 소속 지역 문자열. 한국 밖(북한·바다)이면 None."""
        p = first_inside(self.l7, lat, lon) or first_inside(self.l6, lat, lon)
        if p:
            return self.label[p.id]
        s = self.sido_of(lat, lon)
        return s.name if s else None


# ---------- 원본 읽기 ----------
def pt(e):
    if "lat" in e:
        return e["lat"], e["lon"]
    c = e.get("center")
    return (c["lat"], c["lon"]) if c else None


def alt_names(tags, name):
    out = []
    base = norm(name)
    for k in ("short_name", "alt_name", "official_name", "old_name"):
        for v in (tags.get(k) or "").split(";"):
            v = clean_name(v)
            if v and norm(v) and norm(v) != base and v not in out:
                out.append(v)
    return out[:2]


_BLDG_NO = re.compile(r"[\s\-]*(제\s*)?[0-9A-Za-z]+([\-~][0-9A-Za-z]+)?\s*동$")
_BLDG_KO = re.compile(r"\s+[가-하]\s*동$")


def complex_name(name):
    """아파트 건물 이름에서 동 번호를 뗀다: '래미안 101동' → '래미안', '101동' → ''."""
    n = clean_name(name)
    n2 = _BLDG_KO.sub("", _BLDG_NO.sub("", n)).strip()
    if n2 != n and re.fullmatch(r"[0-9\-\s]*[A-Za-z]?[0-9\-\s]*", n2):
        return ""
    k = norm(n2)
    if len(k) < 2 or k.isdigit():
        return ""
    return n2


def collect(areas, stats):
    """(종류, 이름, lat, lon, 다른 이름들, 우선순위) 목록. 우선순위가 작을수록 중복 제거 때 남는다."""
    items = []

    def add(t, name, p, alts=(), pri=5):
        name = clean_name(name)
        if not name or not p or not norm(name):
            return
        items.append((t, name, p[0], p[1], list(alts), pri))

    # 시·도
    for p in areas.l4:
        add("sido", p.name, p.rep, pri=0)
    # 시·군·구 (area 는 상위 지역)
    for p in areas.l6 + areas.l7:
        add("sigungu", p.name, p.rep, pri=0)

    # 동·읍·면·리 이름 점
    places = load("place_nodes.json")
    by_name = {}
    for e in places:
        tg = e.get("tags", {})
        nm = clean_name(tg.get("name"))
        t = "village" if tg.get("place") == "village" else "dong"
        add(t, nm, pt(e), alt_names(tg, nm), pri=1)
        by_name.setdefault(nm, []).append(pt(e))
    # 행정동 relation: 같은 이름 점(라벨)이 3km 안에 있으면 그 점, 없으면 중심
    for e in load("admin8.json"):
        tg = e.get("tags", {})
        nm = clean_name(tg.get("name"))
        c = pt(e)
        if not nm or not c:
            continue
        near = [q for q in by_name.get(nm, []) if dist_m(q, c) < 3000]
        add("dong", nm, min(near, key=lambda q: dist_m(q, c)) if near else c, alt_names(tg, nm), pri=2)

    # 역(graph.json 의 역 묶음)
    with open(GRAPH, encoding="utf-8") as f:
        g = json.load(f)
    for s in g["stations"]:
        nm = s["name"]
        disp = nm if nm.endswith("역") else nm + "역"
        alts = [a for a in s.get("names", []) if norm(a) != norm(nm)][:2]
        add("station", disp, (s["lat"] / 1e5, s["lon"] / 1e5), alts, pri=0)

    # 공공시설·명소
    for e in load("pois_amenity.json"):
        tg = e.get("tags", {})
        t = AMENITY_TYPE.get(tg.get("amenity"))
        if t:
            add(t, tg.get("name"), pt(e), alt_names(tg, tg.get("name")), pri=0 if e["type"] != "node" else 1)
    for e in load("pois_landmark.json"):
        tg = e.get("tags", {})
        add("landmark", tg.get("name"), pt(e), alt_names(tg, tg.get("name")), pri=0 if e["type"] != "node" else 1)
    # 보충: office=government 중 시청·구청·주민센터류 이름만(나머지 관청은 수가 많고 목적지로 덜 쓰인다), 궁궐·성문·경기장
    if os.path.exists(os.path.join(RAW, "pois_extra.json")):
        for e in load("pois_extra.json"):
            tg = e.get("tags", {})
            nm = tg.get("name")
            pri = 0 if e["type"] != "node" else 1
            if tg.get("office") == "government":
                if GOV_NAME.search(clean_name(nm)):
                    add("gov", nm, pt(e), alt_names(tg, nm), pri=pri + 2)
            else:
                add("landmark", nm, pt(e), alt_names(tg, nm), pri=pri)
    else:
        print("주의: pois_extra.json 없음(구청·시청 보충, 궁궐·성문·경기장 빠짐)")
        stats["pois_extra_missing"] = True

    # 아파트: 주거단지 경계(우선) + 아파트 건물(동 번호를 뗀 단지 이름)
    for e in load("residential.json"):
        tg = e.get("tags", {})
        add("apartment", tg.get("name"), pt(e), pri=0)
    seen = set()
    nb = dropped = 0
    missing = [i for i in range(len(APT_TILES)) if not os.path.exists(os.path.join(RAW, f"apartments_{i}.json"))]
    if missing:  # 아파트 건물은 보충 자료라서 없으면 빼고 만든다(주거단지 경계만 쓴다)
        print("주의: 아파트 건물 원본이 없는 조각:", missing)
        stats["apartment_tiles_missing"] = missing
    for i in range(len(APT_TILES)):
        if i in missing:
            continue
        for e in load(f"apartments_{i}.json"):
            if (e["type"], e["id"]) in seen:
                continue
            seen.add((e["type"], e["id"]))
            nb += 1
            cn = complex_name(e.get("tags", {}).get("name"))
            if not cn:
                dropped += 1
                continue
            add("apartment", cn, pt(e), pri=3)
    stats["apartment_buildings"] = nb
    stats["apartment_buildings_unnamed_complex"] = dropped
    return items


# ---------- 합치기 ----------
def merge(items, areas, stats):
    """지역을 붙이고, 같은 종류·같은 이름 점을 합친다(아파트는 같은 지역 400m 묶음, 나머지는 200m)."""
    out = []
    groups = {}
    outside = {}
    for it in items:
        t, name, lat, lon, alts, pri = it
        if t == "sido":
            area = ""
        elif t == "sigungu":
            area = None
        else:
            area = areas.of(lat, lon)
            if area is None:
                outside[t] = outside.get(t, 0) + 1
                continue
        groups.setdefault((t, norm(name)), []).append([pri, name, lat, lon, alts, area])
    # 시·군·구 area 는 상위 지역
    sg_parent = {}
    for p in areas.l6 + areas.l7:
        sg_parent.setdefault((norm(p.name), round(p.rep[0], 5), round(p.rep[1], 5)), areas.parent[p.id])
    stats["outside_korea_dropped"] = outside

    for (t, k), lst in groups.items():
        lst.sort(key=lambda r: r[0])
        if t == "apartment":
            clusters = []  # [대표 행, 구성 점들]
            for r in lst:
                for c in clusters:
                    if c[0][5] == r[5] and dist_m((c[0][2], c[0][3]), (r[2], r[3])) < APT_CLUSTER_M:
                        c[1].append(r)
                        break
                else:
                    clusters.append([r, [r]])
            for head, mem in clusters:
                if head[0] == 0:  # 주거단지 경계가 있으면 그 중심
                    lat, lon = head[2], head[3]
                else:             # 건물만 있으면 건물 중심들의 평균
                    lat = sum(m[2] for m in mem) / len(mem)
                    lon = sum(m[3] for m in mem) / len(mem)
                n = len(mem)
                if head[0] == 0:  # 주거단지 경계
                    tier = "apartment_A" if APT_WORD.search(head[1]) else "apartment_B"
                else:             # 건물로만 아는 단지
                    tier = "apartment_A" if n >= 5 else "apartment_C" if n >= 2 else "apartment_D"
                out.append((t, head[1], lat, lon, head[5], [], tier, -n))
        else:
            kept = []
            for r in lst:
                if any(dist_m((q[2], q[3]), (r[2], r[3])) < DEDUP_M for q in kept):
                    continue
                kept.append(r)
            for r in kept:
                area = r[5]
                if t == "sigungu":
                    area = sg_parent.get((k, round(r[2], 5), round(r[3], 5)), "")
                alts = [a for a in r[4] if norm(a) != k]
                out.append((t, r[1], r[2], r[3], area, alts, t, 0))
    return out


def encode(rows):
    area_ix = {}
    p = []
    rows = sorted(rows, key=lambda r: (T[r[0]], r[4], r[1]))
    for t, name, lat, lon, area, alts, _tier, _rank in rows:
        if area not in area_ix:
            area_ix[area] = len(area_ix)
        e = [name, T[t], round(lat * 1e5), round(lon * 1e5), area_ix[area]]
        if alts:
            e.append(alts)
        p.append(e)
    doc = {
        "format": "places-1",
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "osm_base": time.strftime("%Y-%m-%d", time.localtime(os.path.getmtime(os.path.join(RAW, "pois_amenity.json")))),
        "types": TYPES,
        "areas": list(area_ix),
        "p": p,
    }
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def fit(rows):
    """SIZE_LIMIT 안에 들도록 CUT_ORDER 순서로 묶음을 뺀다. 넘침을 해소하는 묶음은 중요한 것부터 일부만 남긴다."""
    keep = list(rows)
    cut = {}
    for tier in CUT_ORDER:
        data = encode(keep)
        if len(data) <= SIZE_LIMIT:
            return data, keep, cut
        part = sorted([r for r in keep if r[6] == tier], key=lambda r: r[7])
        rest = [r for r in keep if r[6] != tier]
        if not part:
            continue
        if len(encode(rest)) > SIZE_LIMIT:
            keep, cut[tier] = rest, len(part)
            continue
        lo, hi = 0, len(part)  # 남길 개수를 이분 탐색
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if len(encode(rest + part[:mid])) <= SIZE_LIMIT:
                lo = mid
            else:
                hi = mid - 1
        keep, cut[tier] = rest + part[:lo], len(part) - lo
        return encode(keep), keep, cut
    return encode(keep), keep, cut


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if "--fetch" in sys.argv:
        fetch_missing()
        if "--fetch-only" in sys.argv:
            return
    t0 = time.time()
    stats = {}
    areas = Areas()
    print(f"시·군·구 다각형: 6급 {len(areas.l6)}, 7급 {len(areas.l7)}, 시·도 {len(areas.l4)}; 뺀 것(한국 밖): {areas.dropped}")
    items = collect(areas, stats)
    rows = merge(items, areas, stats)
    data, keep, cut = fit(rows)
    with open(OUT, "wb") as f:
        f.write(data)
    counts = {}
    for r in keep:
        counts[r[0]] = counts.get(r[0], 0) + 1
    print("종류별 개수:", json.dumps({t: counts.get(t, 0) for t in TYPES}, ensure_ascii=False))
    print("합계:", len(keep), "| 크기를 맞추려고 뺀 것(묶음: 개수):", cut or "없음")
    print("기타:", json.dumps(stats, ensure_ascii=False))
    print(f"크기: {len(data):,} byte, gzip {len(gzip.compress(data, 9)):,} byte → {OUT} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
