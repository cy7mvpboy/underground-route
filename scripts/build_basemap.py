# build_basemap.py
# 하는 일: OSM(Overpass) 원본에서 웹 지도용 가벼운 바탕 지도 web\data\basemap.json 을 만든다.
#   - admin : 시·도(admin_level=4) 경계선. 공유 경계는 한 번만 넣고, 해안선과 겹치는 구간은 뺀다.
#   - coast : 한국 영역의 해안선(natural=coastline). 더글러스-포이커로 줄이고 작은 섬은 뺀다.
#   - labels: 시·도 이름(region)과 주요 도시 이름(city).
# 폴리라인은 graph.json 의 edges.g 와 같은 Google 인코딩(소수 5자리)이라 웹의 decodePolyline 을 그대로 쓴다.
# 사용법(프로젝트 폴더에서): python -I scripts\build_basemap.py [--fetch] [--check]
#   --fetch : data\raw\basemap\ 에 원본이 없으면 Overpass 로 받는다(scripts\overpass_fetch.py 재사용, 한 번에 하나씩).
#   --check : 만든 basemap.json 의 폴리라인을 풀어 좌표 범위와 점 개수를 센다.
# 표준 라이브러리만 쓴다(Python 3.13).
import gzip
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw", "basemap")
OUT = os.path.join(ROOT, "web", "data", "basemap.json")
QUERIES = os.path.join(ROOT, "scripts", "queries")

PRECISION = 5  # graph.json 과 같다(소수 5자리)
MIN_RING_M = 2000  # 이보다 짧은 닫힌 해안선(작은 섬)은 뺀다
MIN_OPEN_M = 2000  # 이보다 짧은 열린 해안선 조각도 뺀다
ADMIN_TOL_M = 150  # 경계선 단순화 허용 오차
DMZ_BOX = (37.75, 126.40, 128.45)  # 휴전선 구간 판별: (최소 위도, 최소 경도, 최대 경도)
SOURCES = [  # (원본 파일, 쿼리 파일)
    ("admin.json", "basemap_admin.overpassql"),
    ("admin_centres.json", "basemap_admin_centres.overpassql"),
    ("cities.json", "basemap_cities.overpassql"),
    ("coast.json", "basemap_coast.overpassql"),
]

# 시·도 이름표 위치를 admin_centre 로 쓸 이름 꼬리(광역시·특별시급). 도(道)는 면적 무게중심을 쓴다.
CENTRE_SUFFIX = ("특별시", "광역시", "특별자치시")
CAPITAL_CITIES = ["수원", "춘천", "청주", "전주", "창원", "안동", "제주"]  # 도청 소재지(대표 도시에 항상 포함)
N_CITIES = 20  # 인구순 대표 도시 수(서로 25km 이상 떨어진 것만)
CITY_SPACING_KM = 25
METRO_CITY_NAMES = {"서울특별시", "부산광역시", "대구광역시", "인천광역시", "대전광역시", "울산광역시", "세종특별자치시"}
# 경계 relation 이 바다(영해)까지 포함해 무게중심이 서쪽 바다로 쏠리거나 서울과 겹치는 도는 손으로 정한 위치를 쓴다.
REGION_POINT_OVERRIDE = {
    "경기도": (37.55, 127.45),
    "충청남도": (36.55, 126.85),
    "전북특별자치도": (35.72, 127.15),
    "전남광주통합특별시": (34.85, 126.95),
}


# ---------- 입력 ----------
def fetch_missing():
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import overpass_fetch
    os.makedirs(RAW, exist_ok=True)
    for name, q in SOURCES:
        path = os.path.join(RAW, name)
        if os.path.exists(path):
            continue
        with open(os.path.join(QUERIES, q), encoding="utf-8") as f:
            if not overpass_fetch.fetch(f.read(), path):
                sys.exit("받기 실패: " + name)


def load(name):
    with open(os.path.join(RAW, name), encoding="utf-8") as f:
        d = json.load(f)
    if d.get("remark"):
        print("경고: remark 있음", name, d["remark"])
    return d["elements"]


# ---------- 기하 ----------
def to_xy(pts):
    """[(lat, lon)] -> 미터 단위 평면 좌표(등장방형, 기준 위도 36)."""
    k = 111320.0
    c = math.cos(math.radians(36))
    return [(lon * k * c, lat * k) for lat, lon in pts]


def length_m(pts):
    xy = to_xy(pts)
    return sum(math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]) for i in range(1, len(xy)))


def dp_simplify(pts, tol):
    """더글러스-포이커(반복형). pts 는 [(lat, lon)], 양 끝점은 유지한다."""
    n = len(pts)
    if n < 3:
        return list(pts)
    xy = to_xy(pts)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            if L2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
                d = math.hypot(px - ax - t * dx, py - ay - t * dy)
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def simplify_chain(pts, tol):
    """열린 선은 그대로, 닫힌 고리는 시작점에서 가장 먼 점으로 둘로 갈라 각각 단순화한다."""
    if len(pts) > 3 and pts[0] == pts[-1]:
        xy = to_xy(pts)
        far = max(range(len(pts)), key=lambda i: math.hypot(xy[i][0] - xy[0][0], xy[i][1] - xy[0][1]))
        left = dp_simplify(pts[:far + 1], tol)
        right = dp_simplify(pts[far:], tol)
        return left + right[1:]
    return dp_simplify(pts, tol)


def chain_ways(ways):
    """끝점이 같은 way 들을 이어 붙인다. 세 개 이상 만나는 갈림점에서는 멈춘다. ways: [[(lat, lon)...]]."""
    ends = {}
    for i, w in enumerate(ways):
        for e in (w[0], w[-1]):
            ends.setdefault(e, []).append(i)
    used = [False] * len(ways)
    chains = []

    def extend(chain):
        # chain 의 뒤쪽으로 이어 붙일 수 있는 만큼 이어 붙인다
        while True:
            tail = chain[-1]
            cand = [j for j in ends.get(tail, []) if not used[j]]
            if len(ends.get(tail, [])) != 2 or len(cand) != 1:
                return chain
            j = cand[0]
            used[j] = True
            w = ways[j]
            chain.extend(w[1:] if w[0] == tail else w[-2::-1])

    for i, w in enumerate(ways):
        if used[i]:
            continue
        used[i] = True
        chain = extend(list(w))
        chain.reverse()  # 앞쪽도 같은 방법으로 늘린다
        chain = extend(chain)
        chains.append(chain)
    return chains


def ring_area_centroid(ring):
    """닫힌 고리의 (면적, 무게중심 lat, lon). 평면 근사."""
    xy = to_xy(ring)
    a = cx = cy = 0.0
    for i in range(len(xy) - 1):
        x0, y0 = xy[i]
        x1, y1 = xy[i + 1]
        cr = x0 * y1 - x1 * y0
        a += cr
        cx += (x0 + x1) * cr
        cy += (y0 + y1) * cr
    if a == 0:
        return 0.0, ring[0][0], ring[0][1]
    cx, cy = cx / (3 * a), cy / (3 * a)
    k = 111320.0
    return abs(a) / 2, cy / k, cx / (k * math.cos(math.radians(36)))


# ---------- 인코딩 ----------
def encode_polyline(pts):
    out = []
    plat = plon = 0
    f = 10 ** PRECISION
    for lat, lon in pts:
        ilat, ilon = round(lat * f), round(lon * f)
        for d in (ilat - plat, ilon - plon):
            v = ~(d << 1) if d < 0 else d << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def decode_polyline(s):
    """웹의 decodePolyline 과 같은 알고리즘."""
    pts = []
    i = lat = lon = 0
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
            d = ~(r >> 1) if (r & 1) else (r >> 1)
            if k == 0:
                lat += d
            else:
                lon += d
        pts.append((lat / 10 ** PRECISION, lon / 10 ** PRECISION))
    return pts


def q(pts):
    """인코딩될 좌표(소수 5자리)로 맞춘다. 중복점 제거에 쓴다."""
    out = []
    for lat, lon in pts:
        p = (round(lat, PRECISION), round(lon, PRECISION))
        if not out or out[-1] != p:
            out.append(p)
    return out


# ---------- 해안선 ----------
def build_coast():
    els = [e for e in load("coast.json") if e["type"] == "way" and e.get("geometry")]
    ways = [[(g["lat"], g["lon"]) for g in e["geometry"]] for e in els]
    chains = chain_ways(ways)
    lines = []
    stats = {"ways": len(ways), "chains": len(chains), "dropped_small": 0}
    coast_points = set()
    for c in chains:
        ln = length_m(c)
        closed = c[0] == c[-1]
        if ln < (MIN_RING_M if closed else MIN_OPEN_M):
            stats["dropped_small"] += 1
            continue
        tol = 400 if ln >= 100000 else 300 if ln >= 10000 else 200
        s = q(simplify_chain(c, tol))
        if len(s) < 2:
            continue
        lines.append(s)
        coast_points.update(s)
    stats["kept"] = len(lines)
    # 경계선과 겹치는지 가릴 때 쓸 해안선 점 집합(원본 좌표를 소수 5자리로 맞춘 것, 단순화 전)
    full = set()
    for w in ways:
        full.update((round(a, PRECISION), round(b, PRECISION)) for a, b in w)
    return lines, full, stats


# ---------- 시·도 경계 ----------
def build_admin():
    rels = [e for e in load("admin.json") if e["type"] == "relation"]
    way_geom = {}
    uses = {}
    for r in rels:
        for m in r["members"]:
            if m["type"] == "way" and m.get("geometry"):
                way_geom[m["ref"]] = [(g["lat"], g["lon"]) for g in m["geometry"]]  # id 로 중복 제거 = 공유 경계 한 번
                uses[m["ref"]] = uses.get(m["ref"], 0) + 1
    # OSM 시·도 경계는 바다(영해선)까지 그려져 있다. 쓸 것:
    #  - 두 시·도가 공유하는 way (시·도 사이 경계)
    #  - 한 시·도에만 속해도 휴전선(군사분계선) 구간: DMZ_BOX 안에 전부 들어가는 way
    # 나머지(한 시·도에만 속한 바다 쪽 경계, 해안선과 겹치는 구간)는 coast 가 해안을 그리므로 뺀다.
    dropped_sea = 0
    keep = []
    for wid, g in way_geom.items():
        if uses[wid] >= 2:
            keep.append(g)
            continue
        lats = [p[0] for p in g]
        lons = [p[1] for p in g]
        if min(lats) >= DMZ_BOX[0] and min(lons) >= DMZ_BOX[1] and max(lons) <= DMZ_BOX[2]:
            keep.append(g)
        else:
            dropped_sea += 1
    shared_dropped = dropped_sea
    chains = chain_ways(keep)
    lines = []
    for c in chains:
        s = q(simplify_chain(c, ADMIN_TOL_M))
        if len(s) >= 2:
            lines.append(s)
    info = {"relations": [(r["id"], r["tags"].get("name")) for r in rels],
            "unique_ways": len(way_geom), "dropped_sea_or_coast": shared_dropped,
            "kept_ways": len(keep), "chains": len(chains)}
    return lines, rels, info


# ---------- 이름표 ----------
def region_point(rel):
    """시·도 이름표 위치: 광역시급은 admin_centre, 그 외(도)는 가장 큰 고리의 무게중심."""
    name = rel["tags"]["name"]
    if name in REGION_POINT_OVERRIDE:
        return REGION_POINT_OVERRIDE[name]
    if name.endswith(CENTRE_SUFFIX):
        for m in rel["members"]:
            if m["type"] == "node" and m.get("role") == "admin_centre" and "lat" in m:
                return m["lat"], m["lon"]
    ways = [[(g["lat"], g["lon"]) for g in m["geometry"]]
            for m in rel["members"] if m["type"] == "way" and m.get("geometry") and m.get("role") in ("outer", "")]
    rings = [c for c in chain_ways(ways) if len(c) > 3 and c[0] == c[-1]]
    if rings:
        best = max(rings, key=lambda c: ring_area_centroid(c)[0])
        _, lat, lon = ring_area_centroid(best)
        return lat, lon
    pts = [p for w in ways for p in w]
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def hav_km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def short_city(name):
    return name[:-1] if name.endswith("시") and len(name) > 2 else name


def build_labels(rels):
    labels = []
    for r in rels:
        lat, lon = region_point(r)
        labels.append({"k": "region", "name": r["tags"]["name"], "lat": round(lat, 4), "lon": round(lon, 4)})
    cities = []
    for e in load("cities.json"):
        t = e.get("tags", {})
        try:
            pop = int(t.get("population", "0"))
        except ValueError:
            pop = 0
        if "name" in t and "lat" in e:
            cities.append((pop, t["name"], e["lat"], e["lon"]))
    cities.sort(reverse=True)
    chosen = []
    for pop, name, lat, lon in cities:
        if name in METRO_CITY_NAMES:  # 광역시급은 시·도 이름표가 대신한다
            continue
        if len(chosen) >= N_CITIES:
            break
        if any(hav_km((lat, lon), (c[2], c[3])) < CITY_SPACING_KM for c in chosen):
            continue
        chosen.append((pop, name, lat, lon))
    have = {short_city(c[1]) for c in chosen}
    for cap in CAPITAL_CITIES:
        if cap in have:
            continue
        for pop, name, lat, lon in cities:
            if short_city(name) == cap:
                chosen.append((pop, name, lat, lon))
                break
    for pop, name, lat, lon in chosen:
        labels.append({"k": "city", "name": short_city(name), "lat": round(lat, 4), "lon": round(lon, 4)})
    return labels


# ---------- 점검 ----------
def check(path=OUT):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    counts = {}
    bad = 0
    box = [90, -90, 180, -180]  # [최소 lat, 최대 lat, 최소 lon, 최대 lon]
    for ln in d["lines"]:
        pts = decode_polyline(ln["p"])
        c = counts.setdefault(ln["k"], [0, 0])
        c[0] += 1
        c[1] += len(pts)
        for lat, lon in pts:
            box = [min(box[0], lat), max(box[1], lat), min(box[2], lon), max(box[3], lon)]
            if not (32.5 <= lat <= 39 and 124 <= lon <= 132):
                bad += 1
    for lb in d["labels"]:
        if not (32.5 <= lb["lat"] <= 39 and 124 <= lb["lon"] <= 132):
            bad += 1
    print("종류별 [폴리라인 수, 점 수]:", counts)
    print("범위 밖 좌표:", bad, " lat", box[0], "~", box[1], " lon", box[2], "~", box[3])
    print("라벨:", sum(1 for x in d["labels"] if x["k"] == "region"), "region,",
          sum(1 for x in d["labels"] if x["k"] == "city"), "city")
    raw = os.path.getsize(path)
    with open(path, "rb") as f:
        gz = len(gzip.compress(f.read(), 9))
    print("크기: raw", raw, "byte, gzip", gz, "byte")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    if "--fetch" in args:
        fetch_missing()
    if "--check" in args and "--build" not in args and len(args) == 1:
        check()
        return
    coast, coast_full, cs = build_coast()
    admin, rels, ai = build_admin()
    print("coast:", cs)
    print("admin:", {k: v for k, v in ai.items() if k != "relations"})
    for rid, name in ai["relations"]:
        print("  relation", rid, name)
    labels = build_labels(rels)
    out = {
        "format": "basemap-1",
        "precision": PRECISION,
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "lines": [{"k": "coast", "p": encode_polyline(p)} for p in coast]
        + [{"k": "admin", "p": encode_polyline(p)} for p in admin],
        "labels": labels,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    check()


if __name__ == "__main__":
    main()
