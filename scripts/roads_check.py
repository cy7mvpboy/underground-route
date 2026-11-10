# roads_check.py
# 하는 일: '철도 터널 말고 걸어서 지날 수 있는 지하 통로'로 도로 터널·지하 도로를 쓸 수 있는지 OSM으로 점검한다(확인용, 앱은 바꾸지 않음).
#   1) 도로 터널(highway 도로 등급 + tunnel=yes), 건물 관통 통로(tunnel=building_passage), 보행 터널(footway·path·cycleway)을
#      종류·도로 등급·시·도별 개수와 길이로 센다.
#   2) 이어진 터널 way를 묶어 '터널'로 만들고, 가장 긴 20개와 이름난 도시 터널(신월여의·서부간선·남산 1~3호 등)을 찾는다.
#   3) 터널 출입구(묶음의 끝점)가 역 출구(graph.json entrances)·철도 터널 출입구(egress.json portal)에서 300m·800m 안에 몇 개인지 센다.
#   4) 도로 터널 하나로 서로 다른 '철도 지하 덩어리(지하 간선만으로 이어진 묶음)'를 이을 수 있는 곳을 찾고,
#      철도 그래프만 쓸 때의 지상 노출과 비교한다(지상 걷기 = 직선 × 1.3, 추정).
#   5) 서울의 OSM 대피소 태그(amenity=shelter·emergency·bunker 등, 이름의 대피소·민방위)를 센다.
# 사용법(프로젝트 폴더에서):
#   python -I scripts\roads_check.py --fetch   원본이 없으면 Overpass에서 받는다(한 번에 하나씩) → 그리고 센다
#   python -I scripts\roads_check.py           data\raw\roadtunnel\ 의 원본으로 세기만 한다
# 원본: data\raw\roadtunnel\*.json (Overpass 응답 그대로, 쿼리 원문은 같은 이름의 .overpassql)
# 결과: data\derived\roads_shelters_check.json (숫자와 후보 목록). 사람이 읽는 정리는 docs\roads-shelters-check.md.
# 원칙: Python 표준 라이브러리만 쓴다. Overpass 요청은 scripts\overpass_fetch.py 의 fetch()를 쓴다.
#   서버가 바쁘면 쉬었다가 다시 시도하고(최대 3번), 자료 시각이 2026-11-01보다 오래되면 버린다.
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
RAW = os.path.join(ROOT, "data", "raw", "roadtunnel")
OUT = os.path.join(ROOT, "data", "derived", "roads_shelters_check.json")
GRAPH = os.path.join(ROOT, "web", "data", "graph.json")
EGRESS = os.path.join(ROOT, "web", "data", "egress.json")
ADMIN = os.path.join(ROOT, "data", "raw", "basemap", "admin.json")
HAN = os.path.join(ROOT, "data", "raw", "han_river.json")

MIN_OSM_BASE = "2026-11-01"  # 이보다 오래된 자료(대체 서버의 묵은 자료)는 버린다
CLIENT_WAIT_S = 300          # 서버 하나에서 기다리는 최대 시간

# ---------- Overpass 쿼리 ----------
# 전국을 상자 7개로 나눠 받는다(남,서,북,동). 수도권은 경도 127.0도에서 나눴다(서버 과부하 대비).
TILES = {"E": (33.0, 124.5, 35.0, 131.0), "D": (35.0, 124.5, 36.0, 131.0), "C": (36.0, 124.5, 37.0, 131.0),
         "A1w": (37.0, 124.5, 37.7, 127.0), "A1e": (37.0, 127.0, 37.7, 128.0),
         "A2": (37.7, 124.5, 38.7, 128.0), "B": (37.0, 128.0, 38.7, 131.0)}
SEOUL_BOX = (37.41, 126.76, 37.72, 127.19)
QUERIES = [(f"road_{k}.json",
            f"[out:json][timeout:300][bbox:{s},{w},{n},{e}];\n"
            f"// 상자 {k}: tunnel 태그가 있는(no가 아닌) 모든 highway way. 도로·보행·건물 관통을 만들 때 나눈다.\n"
            "way[highway][tunnel][tunnel!=no];\nout geom;")
           for k, (s, w, n, e) in TILES.items()]
s, w, n, e = SEOUL_BOX
QUERIES += [
    ("shelters_seoul_tags.json",
     f"[out:json][timeout:180][bbox:{s},{w},{n},{e}];\n"
     "// 서울 상자: 대피소로 쓸 만한 태그(shelter, emergency, bunker)\n"
     "(\n  nwr[amenity=shelter];\n  nwr[shelter_type];\n  nwr[emergency];\n  nwr[bunker_type];\n"
     "  nwr[military=bunker];\n  nwr[building=bunker];\n  nwr[\"air_raid_shelter\"];\n);\nout center tags;"),
    ("shelters_seoul_names.json",
     f"[out:json][timeout:180][bbox:{s},{w},{n},{e}];\n"
     "// 서울 상자: 이름에 대피소·대피시설·민방위·방공호가 든 것\n"
     "nwr[name~\"대피소|대피시설|민방위|방공\"];\nout center tags;"),
]

SERVERS = [  # 2026-11-10 저녁: overpass-api.de 가 '용량 초과'라 mail.ru 를 앞에 둔다
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def osm_base(path):
    with open(path, encoding="utf-8") as f:
        head = f.read(600)
    m = re.search(r'"timestamp_osm_base":\s*"([^"]+)"', head)
    return m.group(1) if m else ""


def fetch_one(name, q):
    """쿼리 하나를 받는다. 실패하면 60초·120초 쉬고 다시(최대 3번). 오래된 자료·remark가 있는 응답은 버린다."""
    import urllib.request
    import overpass_fetch
    overpass_fetch.SERVERS[:] = SERVERS
    if not getattr(urllib.request.urlopen, "_clamped", False):
        orig = urllib.request.urlopen

        def urlopen(req, timeout=None, **kw):
            return orig(req, timeout=min(timeout or CLIENT_WAIT_S, CLIENT_WAIT_S), **kw)
        urlopen._clamped = True
        urllib.request.urlopen = urlopen
    path = os.path.join(RAW, name)
    if os.path.exists(path):
        return True
    with open(os.path.join(RAW, name.replace(".json", ".overpassql")), "w", encoding="utf-8") as f:
        f.write(q)
    for attempt, wait in enumerate((60, 120, 0)):
        print(f"받기: {name} (시도 {attempt + 1})", flush=True)
        ok = overpass_fetch.fetch(q, path)
        if ok:
            base = osm_base(path)
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
            if base >= MIN_OSM_BASE and not d.get("remark"):
                time.sleep(15)  # 다음 요청 전에 쉰다(공개 서버 예의)
                return True
            print(f"  버림: 자료 시각 {base}, remark {str(d.get('remark'))[:120]}", flush=True)
            os.replace(path, path.replace(".json", f".rejected-{attempt}.json"))
        if wait:
            time.sleep(wait)
    return False


def fetch_missing():
    os.makedirs(RAW, exist_ok=True)
    failed = [name for name, q in QUERIES if not fetch_one(name, q)]
    if failed:
        print("받지 못함:", ", ".join(failed), flush=True)
    return failed


def load_raw(name):
    path = os.path.join(RAW, name)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    if d.get("remark") or osm_base(path) < MIN_OSM_BASE:
        return None
    return d


# ---------- 거리·격자 ----------
def hav(a, b):
    """두 점 (lat, lon) 사이의 거리(m)."""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


class Grid:
    """0.01도 칸에 점을 넣고, 반경 안의 점을 찾는다(반경 1km 이하용)."""
    def __init__(self):
        self.cells = defaultdict(list)

    def add(self, item, p):
        self.cells[(int(p[0] * 100), int(p[1] * 100))].append((item, p))

    def near(self, p, r):
        ci, cj = int(p[0] * 100), int(p[1] * 100)
        out = []
        for i in (ci - 1, ci, ci + 1):
            for j in (cj - 1, cj, cj + 1):
                for item, q in self.cells.get((i, j), ()):
                    d = hav(p, q)
                    if d <= r:
                        out.append((d, item))
        return sorted(out, key=lambda x: x[0])


WALK_FACTOR = 1.3  # 지상 걷기 = 직선 × 1.3 (실제 길 대신 쓰는 추정)

# ---------- 도로 터널 나누기 ----------
ROAD_RE = re.compile(r"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service)(_link)?$")
PED_RE = re.compile(r"^(footway|path|cycleway)$")


def way_len(geom):
    return sum(hav(a, b) for a, b in zip(geom, geom[1:]))


def load_ways():
    ways, bases, missing = {}, {}, []
    for k in TILES:
        d = load_raw(f"road_{k}.json")
        if d is None:
            missing.append(k)
            continue
        bases[k] = d["osm3s"]["timestamp_osm_base"]
        for el in d["elements"]:
            if el["type"] != "way" or not el.get("geometry"):
                continue
            geom = [(p["lat"], p["lon"]) for p in el["geometry"] if p]
            if len(geom) < 2:
                continue
            ways[el["id"]] = {"id": el["id"], "tags": el.get("tags", {}), "nodes": el["nodes"], "geom": geom,
                              "len": way_len(geom)}
    return ways, bases, missing


def category(w):
    t = w["tags"]
    hw, tun = t.get("highway", ""), t.get("tunnel", "")
    if tun == "building_passage":
        return "building_passage"
    if tun != "yes":
        return "other_tunnel_value"
    if ROAD_RE.match(hw):
        return "road"
    if PED_RE.match(hw):
        return "ped"
    return "other_highway"


def tname(t):
    return (t.get("tunnel:name") or t.get("name") or "").strip()


def name_key(s):
    s = re.sub(r"\(.*?\)", "", s).replace(" ", "")
    s = re.sub(r"(상행|하행|상선|하선|방향|방면)$", "", s)
    return s


# ---------- 터널 묶기 ----------
def components(ways):
    """같은 노드를 쓰는 터널 way를 한 묶음으로(합집합-찾기)."""
    parent = {i: i for i in ways}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    by_node = defaultdict(list)
    for wid, w in ways.items():
        for nd in w["nodes"]:
            by_node[nd].append(wid)
    for ids in by_node.values():
        for o in ids[1:]:
            ra, rb = find(ids[0]), find(o)
            if ra != rb:
                parent[ra] = rb
    groups = defaultdict(list)
    for wid in ways:
        groups[find(wid)].append(wid)
    return list(groups.values())


def comp_graph(ways, wids):
    """묶음 안의 노드 그래프: 노드 → [(이웃, 길이)], 노드 좌표."""
    adj, pos = defaultdict(list), {}
    for wid in wids:
        w = ways[wid]
        for (na, pa), (nb, pb) in zip(zip(w["nodes"], w["geom"]), zip(w["nodes"][1:], w["geom"][1:])):
            d = hav(pa, pb)
            adj[na].append((nb, d))
            adj[nb].append((na, d))
            pos[na], pos[nb] = pa, pb
    return adj, pos


def far(adj, src):
    dist = {src: 0.0}
    heap = [(0.0, src)]
    while heap:
        d, v = heapq.heappop(heap)
        if d > dist[v]:
            continue
        for u, l in adj[v]:
            if d + l < dist.get(u, 1e18):
                dist[u] = d + l
                heapq.heappush(heap, (d + l, u))
    return dist


def build_tunnels(ways, road_ids, regions):
    """도로 터널 묶음(이어진 way) → 이름이 같고 3km 안이면 한 '터널'(쌍굴 등)로 합친다."""
    comps = []
    sub = {i: ways[i] for i in road_ids}
    for wids in components(sub):
        adj, pos = comp_graph(ways, wids)
        ends = [v for v in adj if len(adj[v]) == 1]
        start = ends[0] if ends else next(iter(adj))
        d1 = far(adj, start)
        a = max(d1, key=d1.get)
        d2 = far(adj, a)
        b = max(d2, key=d2.get)
        names = Counter()  # 이름은 길이(m)가 가장 긴 것(연결로 이름보다 본선 터널 이름이 앞서게)
        for i in wids:
            if tname(ways[i]["tags"]):
                names[tname(ways[i]["tags"])] += ways[i]["len"]
        hw = Counter()
        for i in wids:
            hw[ways[i]["tags"]["highway"]] += ways[i]["len"]
        total = sum(ways[i]["len"] for i in wids)
        lat = sum(p[0] for p in pos.values()) / len(pos)
        lon = sum(p[1] for p in pos.values()) / len(pos)
        comps.append({"wids": wids, "span": d2[b], "total": total, "ends": ends, "adj": adj, "pos": pos,
                      "name": names.most_common(1)[0][0] if names else "", "names": list(names),
                      "hw": hw.most_common(1)[0][0], "ref": next((ways[i]["tags"].get("ref") for i in wids
                                                                  if ways[i]["tags"].get("ref")), ""),
                      "c": (lat, lon)})
    # 이름이 같은 묶음끼리 3km 안이면 합친다
    tunnels = []
    by_key = defaultdict(list)
    for ci, c in enumerate(comps):
        by_key[name_key(c["name"]) if c["name"] else f"#{ci}"].append(ci)
    for key, cis in by_key.items():
        left = set(cis)
        while left:
            seed = left.pop()
            members, stack = [seed], [seed]
            while stack:
                x = stack.pop()
                for y in list(left):
                    if hav(comps[x]["c"], comps[y]["c"]) <= 3000:
                        left.discard(y)
                        members.append(y)
                        stack.append(y)
            cs = [comps[m] for m in members]
            span = max(c["span"] for c in cs)
            lat = sum(c["c"][0] for c in cs) / len(cs)
            lon = sum(c["c"][1] for c in cs) / len(cs)
            tunnels.append({"name": cs[0]["name"], "key": key, "comps": members, "len_m": round(span),
                            "total_m": round(sum(c["total"] for c in cs)),
                            "bores": sum(1 for c in cs if c["span"] >= 0.5 * span), "hw": cs[0]["hw"],
                            "ref": cs[0]["ref"], "lat": round(lat, 5), "lon": round(lon, 5),
                            "region": regions.of(lat, lon) or "", "osm_way": cs[0]["wids"][0],
                            "also": sorted({nm for c in cs for nm in c["names"]} - {cs[0]["name"]})[:6]})
    return comps, tunnels


# ---------- 시·도 ----------
class Regions:
    def __init__(self):
        from build_places import Poly  # 시·도 다각형(짝수-홀수 규칙)
        with open(ADMIN, encoding="utf-8") as f:
            rels = [el for el in json.load(f)["elements"] if el["type"] == "relation"]
        self.polys = [Poly(r) for r in rels]

    def of(self, lat, lon):
        for p in self.polys:
            if p.contains(lat, lon):
                return p.name
        return None


# ---------- 이름난 도시 터널(OSM 이름으로 찾기) ----------
FAMOUS = [
    ("신월여의 지하도로(제물포터널)", r"신월여의|신월-여의|제물포터널"),
    ("서부간선 지하도로", r"서부간선"),
    ("남산1호터널", r"남산\s*1\s*호"),
    ("남산2호터널", r"남산\s*2\s*호"),
    ("남산3호터널", r"남산\s*3\s*호"),
    ("홍지문터널", r"홍지문"),
    ("정릉터널", r"정릉"),
    ("강남순환로(관악·봉천·서초 등)", r"강남순환|관악터널|봉천터널|서초터널|우면터널|신림봉천|금천터널|양재터널|선암"),
    ("구룡터널", r"구룡터널"),
    ("북악터널", r"북악터널"),
    ("사직터널", r"사직터널"),
    ("금화터널", r"금화터널"),
    ("우면산터널", r"우면산"),
    ("상도터널", r"상도터널"),
    ("수정산터널(부산)", r"수정산"),
    ("백양터널(부산)", r"백양터널"),
    ("만덕터널(부산)", r"만덕"),
    ("황령터널(부산)", r"황령"),
    ("대티터널(부산)", r"대티"),
    ("구덕터널(부산)", r"구덕터널"),
    ("부산 대심도(만덕-센텀)", r"대심도|센텀"),
    ("거가대교 해저터널(가덕해저터널)", r"가덕|해저|침매|거가대로"),
    ("보령해저터널(충남)", r"보령해저|원산대로"),
    ("인천북항터널", r"인천북항"),
]


# 공개 길이(웹에서 찾은 값, 2026-11-10). 'summary' = 검색 결과 요약에서 얻었고 원문은 직접 확인하지 않음.
PUBLISHED = {
    "신월여의지하도로": {"km": 7.53, "src": "https://news.seoul.go.kr/safe/archives/506675"},
    "서부간선지하도로": {"km": 10.33, "src": "https://mediahub.seoul.go.kr/archives/848695", "note": "노선 전체 길이"},
    "남산1호터널": {"km": 1.530, "src": "summary", "note": "상행 1,530m·하행 1,532m"},
    "남산2호터널": {"km": 1.620, "src": "summary"},
    "남산3호터널": {"km": 1.280, "src": "summary", "note": "1,280m·1,270m"},
    "홍지문터널": {"km": 1.892, "src": "summary"},
    "관악터널(강남순환로)": {"km": 4.990, "src": "https://news.seoul.go.kr/citybuild/archives/231148 (summary)"},
    "봉천터널": {"km": 3.230, "src": "https://news.seoul.go.kr/citybuild/archives/231148 (summary)"},
    "서초터널": {"km": 2.653, "src": "https://news.seoul.go.kr/citybuild/archives/231148 (summary)"},
    "백양터널": {"km": 2.34, "src": "https://www.fnnews.com/news/202406171107466932 (summary)"},
    "만덕센텀 대심도": {"km": 9.62, "src": "https://www.hankyung.com/amp/2026021058506"},
    "만덕3터널(계획)": {"km": 2.24, "src": "https://m.go.seoul.co.kr/news/2016/02/18/20160218500251"},
    "정릉터널": {"km": None, "src": "확인 못 함"},
    "수정산터널": {"km": None, "src": "확인 못 함"},
}

# 민방위 대피시설 자료 후보(페이지만 읽음, 2026-11-10)
SHELTER_DATASETS = [
    {"name": "행정안전부_민방위대피시설 조회서비스", "id": "data.go.kr 15155067",
     "url": "https://www.data.go.kr/data/15155067/openapi.do", "coverage": "전국",
     "coords": "있음, EPSG:5174(보정계수 없는 Bessel 중부원점 TM), 응답 항목 이름은 확인 못 함",
     "fields": "시설명, 시설구분, 주소, 지상·지하, 면적, 최대 수용인원, 운영상태, 지정·해제 이력",
     "format": "REST JSON+XML, 매일 갱신", "license": "이용허락범위 제한 없음, 무료",
     "access": "공공데이터포털 회원 가입 + 활용신청(자동승인), 개발 계정 하루 10,000건"},
    {"name": "행정안전부_생활안전지도 민방위대피소", "id": "data.go.kr 15149489",
     "url": "https://www.data.go.kr/data/15149489/openapi.do", "coverage": "전국",
     "coords": "WMS 지도로만(제공 항목에 좌표 없음)",
     "fields": "대피시설일련번호, 대피가능인원수, 시설구분, 상세주소, 법정동코드, 평상시활용유형, 시설면적, 개방여부, 도로명주소, 관리기관명",
     "format": "WMS(LINK), JSON·XML", "license": "제한 없음", "access": "생활안전지도 키(확인 안 함)"},
    {"name": "서울시 ○○구 민방위대피시설 인허가 정보", "id": "data.seoul.go.kr OA-20035(강북), OA-20036(도봉) 등",
     "url": "https://data.seoul.go.kr/dataList/OA-20035/S/1/datasetView.do", "coverage": "자치구별(25개 구 모두인지 확인 안 함)",
     "coords": "EPSG:5174 TM, 위경도 없음", "fields": "확인 못 함", "format": "시트·Open API(파일 없음)",
     "license": "공공누리 1유형, 매일 갱신(3일 전 자료), 폐업 포함", "access": "Open API는 서울시 인증키"},
    {"name": "지자체 파일(위경도 있음)", "id": "대전 대덕구 15159914, 경남 의령군 15112085, 경기 광주시 15120873(SHP), 대전 유성구 15108921",
     "url": "https://www.data.go.kr/biz/dcat/metadata/15159914.do", "coverage": "시·군·구 몇 곳",
     "coords": "곳마다 다름", "fields": "곳마다 다름", "format": "CSV·SHP·API", "license": "제한 없음", "access": "곳마다 다름"},
    {"name": "안전디딤돌 앱·국민재난안전포털", "id": "", "url": "", "coverage": "전국", "coords": "화면 지도",
     "fields": "", "format": "앱·웹", "license": "", "access": "공개 일괄 내려받기·API를 찾지 못함"},
]


# ---------- 철도 그래프 ----------
def load_rail():
    import route
    g = route.load_graph(GRAPH)
    nn = len(g["nodes"]["f"])
    parent = list(range(nn))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    E = g["edges"]
    under = g["weights"]["under"]
    has_under = [False] * nn
    for i, (a, b) in enumerate(zip(E["a"], E["b"])):
        if g["weight"][i] == under:
            has_under[a] = has_under[b] = True
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb
    comp = [find(i) if has_under[i] else -1 for i in range(nn)]
    # 덩어리 이름: 지하 허브가 있는 역 중 출구 수가 많은 역 2개 + 역 수
    st_in = defaultdict(set)
    for si, st in enumerate(g["stations"]):
        for v in st["hubs"]:
            if comp[v] >= 0:
                st_in[comp[v]].add(si)
    ent_count = Counter(g["entrances"]["station"])
    label = {}
    for c, sts in st_in.items():
        top = sorted(sts, key=lambda si: -ent_count[si])[:2]
        label[c] = (" · ".join(g["stations"][si]["name"] for si in top) + f" 등 {len(sts)}역")
    g["comp"], g["comp_label"], g["comp_stations"] = comp, label, st_in
    return g


def node_pt(g, v):
    return (g["nodes"]["lat"][v] / 1e5, g["nodes"]["lon"][v] / 1e5)


def station_pt(g, si):
    """역 좌표(그래프에는 위도·경도 × 100000 정수로 들어 있다)."""
    return (g["stations"][si]["lat"] / 1e5, g["stations"][si]["lon"] / 1e5)


def min_exposure(g, sources, targets):
    """철도 그래프에서 sources → targets 의 가장 싼 경로. (지상 노출 m, 전체 m) 또는 None."""
    import route
    end, prev = route.dijkstra(g, sources, targets)
    if end is None:
        return None
    exp = tot = 0.0
    for ei, _, _ in route.path_edges(prev, end):
        tot += g["edges"]["len"][ei]
        if route.is_exposed(g, ei):
            exp += g["edges"]["len"][ei]
    return round(exp), round(tot)


def under_dist(g, sources):
    """지하 간선만 따라 sources 에서 각 노드까지의 거리(m)."""
    E, under = g["edges"], g["weights"]["under"]
    dist = {v: 0.0 for v in sources}
    heap = [(0.0, v) for v in sources]
    while heap:
        d, v = heapq.heappop(heap)
        if d > dist[v]:
            continue
        for ei, u in g["adj"][v]:
            if g["weight"][ei] != under:
                continue
            nd = d + E["len"][ei]
            if nd < dist.get(u, 1e18):
                dist[u] = nd
                heapq.heappush(heap, (nd, u))
    return dist


# ---------- 한강 횡단 ----------
def crosses(p1, p2, q1, q2):
    def ccw(a, b, c):
        return (c[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (c[1] - a[1])
    return (ccw(p1, p2, q1) > 0) != (ccw(p1, p2, q2) > 0) and (ccw(q1, q2, p1) > 0) != (ccw(q1, q2, p2) > 0)


def han_line():
    with open(HAN, encoding="utf-8") as f:
        d = json.load(f)
    for el in d["elements"]:
        if el["type"] == "way" and el.get("geometry"):
            return [(p["lat"], p["lon"]) for p in el["geometry"]]
    nodes = {el["id"]: (el["lat"], el["lon"]) for el in d["elements"] if el["type"] == "node"}
    for el in d["elements"]:
        if el["type"] == "way":
            return [nodes[n] for n in el["nodes"] if n in nodes]
    return []


# ---------- 대피소(OSM, 서울) ----------
def shelters(regions):
    out = {"files": {}, "seoul_only": True}
    seen = {}
    for name in ("shelters_seoul_tags.json", "shelters_seoul_names.json"):
        d = load_raw(name)
        out["files"][name] = "ok" if d else "missing"
        if not d:
            continue
        for el in d["elements"]:
            c = el.get("center") or ({"lat": el["lat"], "lon": el["lon"]} if "lat" in el else None)
            if not c or regions.of(c["lat"], c["lon"]) != "서울특별시":
                continue
            seen[(el["type"], el["id"])] = (el.get("tags", {}), c)
    cnt = Counter()
    examples = defaultdict(list)
    for (typ, i), (t, c) in seen.items():
        keys = []
        if t.get("amenity") == "shelter":
            keys.append("amenity=shelter / shelter_type=" + t.get("shelter_type", "(없음)"))
        if "emergency" in t:
            keys.append("emergency=" + t["emergency"])
        for k in ("bunker_type", "military", "air_raid_shelter"):
            if k in t and (k != "military" or t[k] == "bunker"):
                keys.append(f"{k}={t[k]}")
        if t.get("building") == "bunker":
            keys.append("building=bunker")
        nm = t.get("name", "")
        if re.search("대피소|대피시설|민방위|방공", nm):
            keys.append("name~대피소|민방위")
            if len(examples["name"]) < 15:
                examples["name"].append({"osm": f"{typ}/{i}", "name": nm, "tags": {k: v for k, v in t.items()
                                         if k in ("amenity", "shelter_type", "emergency", "building", "level")}})
        for k in keys:
            cnt[k] += 1
    out["counts"] = dict(cnt.most_common())
    out["examples"] = dict(examples)
    return out


# ---------- 본 점검 ----------
def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if "--fetch" in sys.argv:
        fetch_missing()
        if "--fetch-only" in sys.argv:
            return
    regions = Regions()
    ways, bases, missing = load_ways()
    print(f"way {len(ways):,}개, 받은 상자 {sorted(bases)}, 빠진 상자 {missing}")
    rep = {"osm_base": bases, "missing_tiles": missing, "walk_factor": WALK_FACTOR}

    # 0) 상자에 함께 들어온 외국 way를 뺀다: 시·도 다각형 밖이면서
    #    일본(쓰시마·규슈: 북위 34.9도 남쪽, 동경 129.15도 동쪽) 또는 북한(북위 37.7도 북쪽)인 것.
    #    다각형 밖이라도 그 밖의 것(거가대로 해저 구간 같은 바다 위 구간)은 남긴다.
    mid = {wid: w["geom"][len(w["geom"]) // 2] for wid, w in ways.items()}
    reg = {i: (regions.of(*mid[i]) or "(바다·경계 밖)") for i in ways}
    foreign = Counter()
    for i in list(ways):
        if reg[i] == "(바다·경계 밖)":
            la, lo = mid[i]
            where = "일본" if (la < 34.9 and lo > 129.15) else "북한" if la > 37.7 else None
            if where:
                foreign[where] += 1
                del ways[i]
    rep["dropped_foreign_ways"] = dict(foreign)
    print("뺀 외국 way:", dict(foreign))

    # 1) 종류·등급·시·도별 개수와 길이
    cat = defaultdict(list)
    for w in ways.values():
        cat[category(w)].append(w["id"])
    def summ(ids, key):
        c, km = Counter(), Counter()
        for i in ids:
            k = key(ways[i])
            c[k] += 1
            km[k] += ways[i]["len"] / 1000
        return {k: {"ways": c[k], "km": round(km[k], 1)} for k in sorted(c, key=lambda x: -km[x])}
    rep["by_category"] = summ(list(ways), category)
    rep["tunnel_values"] = summ(list(ways), lambda w: w["tags"].get("tunnel", ""))
    rep["road_by_highway"] = summ(cat["road"], lambda w: w["tags"]["highway"])
    rep["road_by_region"] = summ(cat["road"], lambda w: reg[w["id"]])
    rep["ped_by_highway"] = summ(cat["ped"], lambda w: w["tags"]["highway"])
    rep["ped_by_region"] = summ(cat["ped"], lambda w: reg[w["id"]])
    rep["building_passage_by_highway"] = summ(cat["building_passage"], lambda w: w["tags"]["highway"])
    rep["other_highway"] = summ(cat["other_highway"], lambda w: w["tags"]["highway"])
    noise = [i for i in cat["road"] if re.search("방음", tname(ways[i]["tags"]))]
    underpass = [i for i in cat["road"] if re.search("지하차도", tname(ways[i]["tags"]))]
    covered = [i for i in cat["road"] if ways[i]["tags"].get("covered") == "yes"]
    rep["road_flags"] = {"방음터널(이름)": {"ways": len(noise), "km": round(sum(ways[i]["len"] for i in noise) / 1000, 1)},
                         "지하차도(이름)": {"ways": len(underpass), "km": round(sum(ways[i]["len"] for i in underpass) / 1000, 1)},
                         "covered=yes": len(covered),
                         "layer<0 없음": sum(1 for i in cat["road"] if not str(ways[i]["tags"].get("layer", "")).startswith("-"))}

    # 2) 터널 묶기, 가장 긴 20개, 이름난 터널
    comps, tunnels = build_tunnels(ways, cat["road"], regions)
    tunnels.sort(key=lambda t: -t["len_m"])
    rep["tunnel_count"] = {"components": len(comps), "tunnels": len(tunnels),
                           "named": sum(1 for t in tunnels if t["name"]),
                           ">=1km": sum(1 for t in tunnels if t["len_m"] >= 1000),
                           ">=3km": sum(1 for t in tunnels if t["len_m"] >= 3000)}
    rep["longest20"] = [{k: t[k] for k in ("name", "len_m", "bores", "total_m", "hw", "ref", "region", "lat", "lon", "osm_way", "also")}
                        for t in tunnels[:20]]
    fam = {}
    for label, pat in FAMOUS:
        rx = re.compile(pat)
        hits = [t for t in tunnels if t["name"] and rx.search(t["name"])]
        fam[label] = [{k: t[k] for k in ("name", "len_m", "bores", "total_m", "hw", "region", "lat", "lon", "osm_way")}
                      for t in sorted(hits, key=lambda t: -t["len_m"])[:8]]
    rep["famous"] = fam
    rep["published_lengths"] = PUBLISHED
    rep["shelter_datasets"] = SHELTER_DATASETS
    # 서울·부산 이름 있는 터널 500m 이상 목록(이름 확인용)
    rep["named_city_tunnels"] = {r: [(t["name"], t["len_m"]) for t in tunnels
                                     if t["region"] == r and t["name"] and t["len_m"] >= 500]
                                 for r in ("서울특별시", "부산광역시")}

    # 한강 횡단
    han = han_line()
    hx = []
    for i in cat["road"] + cat["ped"]:
        gm = ways[i]["geom"]
        if any(crosses(a, b, c, d) for a, b in zip(gm, gm[1:]) for c, d in zip(han, han[1:])
               if max(a[0], b[0]) >= min(c[0], d[0]) - 0.01 and min(a[0], b[0]) <= max(c[0], d[0]) + 0.01
               and max(a[1], b[1]) >= min(c[1], d[1]) - 0.01 and min(a[1], b[1]) <= max(c[1], d[1]) + 0.01):
            hx.append({"osm_way": i, "name": tname(ways[i]["tags"]), "highway": ways[i]["tags"]["highway"],
                       "len_m": round(ways[i]["len"])})
    rep["han_crossing_road_tunnels"] = hx

    # 3) 출입구 근접
    g = load_rail()
    rail_pts = Grid()
    ent = g["entrances"]
    for v, si in zip(ent["node"], ent["station"]):
        rail_pts.add(("exit", v, si), node_pt(g, v))
    with open(EGRESS, encoding="utf-8") as f:
        eg = json.load(f)
    for it in eg["items"]:
        if it["k"] == "portal":
            rail_pts.add(("portal", it["node"], it["name"]), (it["lat"], it["lon"]))
    portals = []  # (터널 번호, 묶음 번호, 노드, 좌표)
    comp_tunnel = {}
    for ti, t in enumerate(tunnels):
        for ci in t["comps"]:
            comp_tunnel[ci] = ti
    for ci, c in enumerate(comps):
        for v in c["ends"]:
            portals.append((comp_tunnel[ci], ci, v, c["pos"][v]))
    # 출입구(끝점)마다 300m·800m 안의 역 출구·철도 터널 출입구. 터널 길이(0·300·1000m 이상)별로 나눠 센다.
    near_cache = {}
    for ti, ci, v, p in portals:
        hits = rail_pts.near(p, 800)
        near_cache[(ci, v)] = [(d, it[0]) for d, it in hits]
    prox = {}
    for lo in (0, 300, 1000):
        for r in (300, 800):
            n = ne = npt = na = 0
            t_any, t_pts = set(), defaultdict(set)
            for ti, ci, v, p in portals:
                if tunnels[ti]["len_m"] < lo:
                    continue
                n += 1
                hits = [k for d, k in near_cache[(ci, v)] if d <= r]
                ke, kp = "exit" in hits, "portal" in hits
                ne += ke
                npt += kp
                if ke or kp:
                    na += 1
                    t_any.add(ti)
                    t_pts[ti].add(v)
            prox[f"len>={lo}m/{r}m"] = {
                "tunnels": sum(1 for t in tunnels if t["len_m"] >= lo), "road_portals": n,
                "near_station_exit": ne, "near_rail_portal": npt, "near_either": na,
                "tunnels_with_a_near_portal": len(t_any),
                "tunnels_with_2plus_near_portals": sum(1 for s in t_pts.values() if len(s) >= 2)}
    rep["proximity"] = prox

    # 4) 서로 다른 철도 지하 덩어리를 잇는 도로 터널
    MAXW = 800
    cands = {}
    for ci, c in enumerate(comps):
        if c["span"] < 200 or len(c["ends"]) < 2:
            continue
        near = {}
        for v in c["ends"]:
            for d, item in rail_pts.near(c["pos"][v], MAXW):
                node = item[1]
                # 역이 있는 지하 덩어리만 본다(역이 없는 철도 터널 하나짜리 덩어리는 목적지가 아님)
                if node is None or g["comp"][node] < 0 or g["comp"][node] not in g["comp_stations"]:
                    continue
                key = (v, g["comp"][node])
                if key not in near or d < near[key][0]:
                    near[key] = (d, item)
        tun_d = None
        for (v1, c1), (d1, it1) in near.items():
            for (v2, c2), (d2, it2) in near.items():
                if c1 >= c2 or v1 == v2:
                    continue
                if tun_d is None or v1 not in tun_d:
                    tun_d = {v1: far(c["adj"], v1)}
                inside = tun_d[v1].get(v2)
                if inside is None or hav(c["pos"][v1], c["pos"][v2]) < 150:
                    continue
                walk = (d1 + d2) * WALK_FACTOR
                pair = (c1, c2)
                if pair not in cands or walk < cands[pair]["walk_m"]:
                    cands[pair] = {"tunnel": tunnels[comp_tunnel[ci]]["name"] or f"(이름 없음 {c['hw']})",
                                   "tunnel_len_m": tunnels[comp_tunnel[ci]]["len_m"], "inside_m": round(inside),
                                   "region": tunnels[comp_tunnel[ci]]["region"], "osm_way": c["wids"][0],
                                   "walk_m": round(walk), "end1": it1, "end2": it2,
                                   "d1": round(d1), "d2": round(d2),
                                   "direct_walk_m": round(hav(node_pt(g, it1[1]), node_pt(g, it2[1])) * WALK_FACTOR)}
    print(f"섬 잇기 후보 {len(cands)}쌍 — 철도 그래프만의 노출을 계산한다", flush=True)

    # 4-1) 도시 회랑: 대도시의 300m 이상 터널 중 한쪽 끝이 지하역 출구 800m 안인 것.
    #      다른 쪽 끝에서 가장 가까운 지하역 출구까지의 거리 = 터널이 지하 이동 범위를 얼마나 넓히나(지상으로 걸었을 때와 비교).
    ug_exit = Grid()
    for v, si in zip(ent["node"], ent["station"]):
        if g["comp"][v] >= 0 and g["comp"][v] in g["comp_stations"]:
            ug_exit.add((v, si), node_pt(g, v))
    CITIES = ("서울특별시", "부산광역시", "대구광역시", "인천광역시", "대전광역시", "울산광역시", "전남광주통합특별시", "경기도")
    corridors = []
    for ti, t in enumerate(tunnels):
        if t["len_m"] < 300 or t["region"] not in CITIES:
            continue
        best = None
        for ci in t["comps"]:
            c = comps[ci]
            ends = [v for v in c["ends"]]
            for v1 in ends:
                h1 = ug_exit.near(c["pos"][v1], 800)
                if not h1:
                    continue
                dd = far(c["adj"], v1)
                for v2 in ends:
                    if v2 == v1 or dd.get(v2, 0) < 300:
                        continue
                    h2 = ug_exit.near(c["pos"][v2], 800)
                    d2 = h2[0][0] if h2 else None
                    far_end = c["pos"][v2]
                    key = (h1[0][0], -(dd[v2]))
                    if best is None or key < best[0]:
                        si1 = h1[0][1][1]
                        si2 = h2[0][1][1] if h2 else None
                        same = si2 is not None and g["comp"][h1[0][1][0]] == g["comp"][h2[0][1][0]]
                        best = (key, {"tunnel": t["name"] or f"(이름 없음 {t['hw']})", "region": t["region"],
                                      "len_m": t["len_m"], "inside_m": round(dd[v2]), "osm_way": t["osm_way"],
                                      "end1_exit": g["stations"][si1]["name"], "end1_m": round(h1[0][0]), "_si1": si1,
                                      "end2_exit": g["stations"][si2]["name"] if si2 is not None else None,
                                      "end2_m": round(d2) if d2 is not None else None,
                                      "end2_same_island": same, "end2_latlon": [round(far_end[0], 5), round(far_end[1], 5)]})
        if best:
            corridors.append(best[1])
    corridors.sort(key=lambda x: (x["end2_m"] is not None, -(x["len_m"])))

    # 4-2) 예시 여행(범위 넓히기): 출발 = 터널 가까운 끝의 지하역, 도착 = 터널 먼 끝(지하역 출구 800m 밖).
    #      철도만: 출발역에서 철도 그래프로 갈 수 있는 '지상으로 나가는 점'(출구·터널 출입구·지상 선로 노드) 중
    #              (그 점까지 지상 노출 + 그 점에서 도착까지 직선 × 1.3)이 가장 작은 것.
    #      도로 터널: 출발역 출구 → 터널 입구 지상 걷기(직선 × 1.3)만 노출, 터널 안은 지하로 본다.
    E = g["edges"]
    under = g["weights"]["under"]
    exitable = [v for v in range(len(g["nodes"]["f"])) if g["nodes"]["f"][v] & 5
                or any(g["weight"][ei] != under for ei, _ in g["adj"][v])]
    ex_grid = Grid()
    for v in exitable:
        ex_grid.add(v, node_pt(g, v))

    def exposure_tree(sources):
        cost, exp, tot = {v: 0.0 for v in sources}, {v: 0.0 for v in sources}, {v: 0.0 for v in sources}
        heap = [(0.0, v) for v in sources]
        while heap:
            c, v = heapq.heappop(heap)
            if c > cost[v]:
                continue
            for ei, u in g["adj"][v]:
                nc = c + E["len"][ei] * g["weight"][ei]
                if nc < cost.get(u, 1e18):
                    cost[u] = nc
                    exp[u] = exp[v] + (E["len"][ei] if g["weight"][ei] != under else 0)
                    tot[u] = tot[v] + E["len"][ei]
                    heapq.heappush(heap, (nc, u))
        return exp, tot

    exit_label = {v: f"{g['stations'][s_]['name']}역 출구{(' ' + r_ + '번') if r_ else ''}"
                  for v, s_, r_ in zip(ent["node"], ent["station"], ent["ref"])}
    range_trips = []
    for x in [c for c in corridors if c["end2_m"] is None][:12]:
        si = x["_si1"]  # 이름이 같은 역이 여러 도시에 있어(예: 교대) 역 번호로 고른다
        exp, tot = exposure_tree(g["stations"][si]["hubs"])
        dest = tuple(x["end2_latlon"])
        best = None
        for r in (1500, 4000, 10000):
            # 격자는 1km 반경용이라, 넓은 반경은 전체 점을 훑는다
            pts = ex_grid.near(dest, r) if r <= 1000 else [(hav(dest, node_pt(g, v)), v) for v in exitable
                                                            if abs(node_pt(g, v)[0] - dest[0]) < r / 111000]
            for d, v in pts:
                if v in exp:
                    e_ = exp[v] + d * WALK_FACTOR
                    if best is None or e_ < best[0]:
                        best = (e_, v, d)
            if best:
                break
        rail_exp = round(best[0]) if best else None
        tun_exp = round(x["end1_m"] * WALK_FACTOR)
        range_trips.append({"from_station": x["end1_exit"], "to": f"{x['tunnel']} 먼 쪽 끝 {x['end2_latlon']}",
                            "tunnel": x["tunnel"], "region": x["region"],
                            "rail_only_exposure_m": rail_exp,
                            "rail_only_exit": (exit_label.get(best[1], "선로·터널 출입구 점") if best else None),
                            "rail_only_exit_latlon": (node_pt(g, best[1]) if best else None),
                            "rail_only_exit_to_dest_m": round(best[2]) if best else None,
                            "tunnel_exposure_m": tun_exp, "tunnel_inside_m": x["inside_m"],
                            "saving_m": (rail_exp - tun_exp) if rail_exp is not None else None})
    rep["range_trips"] = range_trips
    rep["urban_corridors"] = {"count": len(corridors),
                              "other_end_beyond_800m_of_ug_exit": sum(1 for x in corridors if x["end2_m"] is None),
                              "list": [{k: v for k, v in x.items() if not k.startswith("_")} for x in corridors[:60]]}
    comp_nodes = defaultdict(list)
    for v, cc in enumerate(g["comp"]):
        if cc >= 0:
            comp_nodes[cc].append(v)
    bridges = []
    for (c1, c2), x in cands.items():
        base = min_exposure(g, comp_nodes[c1], comp_nodes[c2])
        rail_exp = base[0] if base else None
        alt = min(v for v in (rail_exp, x["direct_walk_m"]) if v is not None)
        def end_txt(it):
            if it[0] == "exit":
                ref = ent["ref"][ent["node"].index(it[1])]
                return f"{g['stations'][it[2]]['name']}역 출구{(' ' + ref + '번') if ref else ''}"
            return it[2]
        bridges.append({"island1": g["comp_label"].get(c1, f"덩어리 {c1}"), "island2": g["comp_label"].get(c2, f"덩어리 {c2}"),
                        "tunnel": x["tunnel"], "tunnel_len_m": x["tunnel_len_m"], "inside_m": x["inside_m"],
                        "region": x["region"], "osm_way": x["osm_way"],
                        "end1": end_txt(x["end1"]), "end1_m": x["d1"], "end2": end_txt(x["end2"]), "end2_m": x["d2"],
                        "exposure_with_tunnel_m": x["walk_m"], "rail_only_exposure_m": rail_exp,
                        "rail_only_total_m": base[1] if base else None, "surface_direct_walk_m": x["direct_walk_m"],
                        "saving_vs_rail_m": (rail_exp - x["walk_m"]) if rail_exp is not None else None,
                        "saving_vs_best_alt_m": alt - x["walk_m"],
                        "_c": (c1, c2), "_n": (x["end1"][1], x["end2"][1])})
    bridges.sort(key=lambda b: -(b["saving_vs_best_alt_m"]))
    rep["bridge_candidates"] = {"pairs": len(bridges),
                                "saving_vs_best_alt_over_500m": sum(1 for b in bridges if b["saving_vs_best_alt_m"] >= 500),
                                "saving_vs_rail_over_1km": sum(1 for b in bridges if (b["saving_vs_rail_m"] or 0) >= 1000),
                                "top": [{k: v for k, v in b.items() if not k.startswith("_")} for b in bridges[:30]]}

    # 예시 여행: 두 덩어리에서 터널 끝에 가까운 역끼리(철도만 vs 도로 터널 이용)
    trips = []
    for b in bridges[:12]:
        n1, n2 = b["_n"]
        st = []
        for n in (n1, n2):
            dist = under_dist(g, [n])
            best = min(((dist[h], si) for si in g["comp_stations"].get(g["comp"][n], ())
                        for h in g["stations"][si]["hubs"] if h in dist), default=None)
            st.append(best)
        if None in st:
            continue
        (u1, s1), (u2, s2) = st
        if s1 == s2:
            continue
        base = min_exposure(g, g["stations"][s1]["hubs"], g["stations"][s2]["hubs"])
        trips.append({"from": g["stations"][s1]["name"], "to": g["stations"][s2]["name"], "via": b["tunnel"],
                      "rail_only": {"exposure_m": base[0] if base else None, "total_m": base[1] if base else None},
                      "with_road_tunnel": {"exposure_m": b["exposure_with_tunnel_m"],
                                           "total_m": round(u1 + b["end1_m"] * WALK_FACTOR + b["inside_m"]
                                                            + b["end2_m"] * WALK_FACTOR + u2)},
                      "surface_direct_walk_m": round(hav(station_pt(g, s1), station_pt(g, s2)) * WALK_FACTOR)})
    rep["example_trips"] = trips

    # 5) 대피소
    rep["osm_shelters_seoul"] = shelters(regions)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: rep[k] for k in ("by_category", "tunnel_count")}, ensure_ascii=False))
    print("저장:", OUT)


if __name__ == "__main__":
    main()
