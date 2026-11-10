# abandoned_check.py
# 하는 일: 폐선(abandoned)·휴선(disused)·공사중(construction)·계획(proposed)·철거(razed) 철도와
#   폐선을 개조한 보행·자전거 터널을 OSM에서 받은 원본(data\raw\abandoned\q*.json)으로 집계한다.
#   - 분류별 터널 way 수, 터널 km, 시·도별(근사), 가장 긴 터널 20개, 공사중 노선별 터널 km
#   - 운행 중인 철도(data\derived\ways_kr.json)와의 연결(노드 공유 / 50 m 이내), 대도시권 여부
#   - 접근 관련 태그(access, foot, bicycle, highway, usage, note, description) 빈도
# 사용법: python -I scripts\abandoned_check.py
# 입력: data\raw\abandoned\q1_railway.json, q2_prefixed.json, q3_trail.json, q4_constr_rels.json, q5_trail_rels.json
# 출력: data\derived\abandoned_check.json
# 분류 규칙
#   - railway 값이 abandoned/disused/construction/proposed/razed 이면 그 값.
#   - railway 가 없고 '<상태>:railway' 접두 태그만 있으면 그 상태.
#   - railway=rail 등 운행 선로인데 'construction:railway' 접두 태그가 붙은 way 는 '운행선+공사태그'로 따로 센다(분류 합계에서 제외).
#   - highway 가 cycleway/footway/path/track/service/pedestrian/bridleway/steps 인 터널 way 는 'trail'(보행 전환)로 분류한다.
#     (폐선 태그를 직접 가졌거나, 폐선 way 30 m 이내에 있는 것. 30 m 이내는 Overpass around 로 받았다.)
#     trail 이 우선이고, 원래 폐선 태그가 있었는지는 was_status 로 남긴다.
#   - 터널 = tunnel 태그가 있고 'no' 가 아님.
# 시·도는 정확한 경계가 아니다: 가운데 점이 대도시 중심에서 반경 안이면 그 시, 아니면 가장 가까운 도 중심점으로 근사한다.
import json
import math
import sys
from collections import Counter, defaultdict

RAW = "data/raw/abandoned/"
STATUSES = ["abandoned", "disused", "construction", "proposed", "razed"]
TRAIL_HW = {"cycleway", "footway", "path", "track", "service", "pedestrian", "bridleway", "steps"}
OPERATING = {"rail", "subway", "light_rail", "monorail", "narrow_gauge"}
ACCESS_KEYS = ["access", "foot", "bicycle", "highway", "usage", "note", "description"]

# (이름, 위도, 경도, 반경 km) - 대도시. 반경 안이면 해당 시로 본다.
CITIES = [
    ("서울", 37.566, 126.978, 14), ("인천", 37.456, 126.705, 14), ("부산", 35.18, 129.075, 18),
    ("대구", 35.872, 128.601, 14), ("대전", 36.35, 127.385, 12), ("울산", 35.54, 129.31, 12),
    ("광주", 35.16, 126.851, 11), ("세종", 36.48, 127.289, 10),
]
PROVINCES = [  # 도 중심점 근사
    ("경기", 37.40, 127.20), ("강원", 37.80, 128.30), ("충북", 36.75, 127.75), ("충남", 36.50, 126.80),
    ("전북", 35.70, 127.15), ("전남(광주 포함)", 34.95, 126.95), ("경북", 36.40, 128.80),
    ("경남", 35.40, 128.30), ("제주", 33.40, 126.55),
]
# 대도시권(운행선과 이어질 수 있는 도시 안): 중심에서 이 반경 안
METRO = [("수도권", 37.50, 126.99, 45), ("부산권", 35.18, 129.05, 25), ("대구권", 35.87, 128.60, 20),
         ("대전권", 36.35, 127.385, 18), ("광주권", 35.16, 126.851, 15)]


def hav_km(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def length_km(pts):
    return sum(hav_km(a[0], a[1], b[0], b[1]) for a, b in zip(pts, pts[1:]))


def region_of(lat, lon):
    for name, la, lo, rad in CITIES:
        if hav_km(lat, lon, la, lo) <= rad:
            return name
    return min(PROVINCES, key=lambda p: hav_km(lat, lon, p[1], p[2]))[0]


def metro_of(lat, lon):
    for name, la, lo, rad in METRO:
        if hav_km(lat, lon, la, lo) <= rad:
            return name
    return None


def load(name):
    with open(RAW + name, encoding="utf-8") as f:
        return json.load(f)["elements"]


def is_tunnel(tags):
    t = tags.get("tunnel")
    return bool(t) and t != "no"


def classify(tags):
    """(분류, 원래 상태) 를 돌려준다. 분류 None 이면 집계 대상 아님."""
    rw = tags.get("railway")
    status = None
    if rw in STATUSES:
        status = rw
    else:
        for s in STATUSES:
            if (s + ":railway") in tags:
                status = s
                break
    if status is None:
        return None, None
    if rw in OPERATING:
        return "operating_with_prefix", status
    if tags.get("highway") in TRAIL_HW:
        return "trail", status
    return status, status


def name_of(tags):
    for k in ("name", "name:ko", "old_name", "official_name", "ref"):
        if tags.get(k):
            return tags[k]
    for k in tags:
        if k.endswith(":name") or k in ("abandoned:name", "disused:name", "construction:name"):
            return tags[k]
    return ""


def simplify(pts, n=4):
    if len(pts) <= n:
        return pts
    idx = sorted(set(round(i * (len(pts) - 1) / (n - 1)) for i in range(n)))
    return [pts[i] for i in idx]


def seg_dist_m(plat, plon, a, b):
    """점-선분 거리(m). 국소 평면 근사."""
    k = math.cos(math.radians(plat))
    ax, ay = (a[1] - plon) * k * 111320, (a[0] - plat) * 110540
    bx, by = (b[1] - plon) * k * 111320, (b[0] - plat) * 110540
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, -(ax * dx + ay * dy) / L))
    return math.hypot(ax + t * dx, ay + t * dy)


class SegIndex:
    """운행선 선분을 0.01도 칸에 넣어 근처 검색."""
    def __init__(self):
        self.cells = defaultdict(list)

    def add(self, wid, geom):
        for a, b in zip(geom, geom[1:]):
            lo0, lo1 = sorted((int(a[0] * 100), int(b[0] * 100)))
            lg0, lg1 = sorted((int(a[1] * 100), int(b[1] * 100)))
            for i in range(lo0, lo1 + 1):
                for j in range(lg0, lg1 + 1):
                    self.cells[(i, j)].append((wid, a, b))

    def nearest(self, lat, lon, limit_m):
        best = (1e9, None)
        ci, cj = int(lat * 100), int(lon * 100)
        for i in (ci - 1, ci, ci + 1):
            for j in (cj - 1, cj, cj + 1):
                for wid, a, b in self.cells.get((i, j), ()):
                    d = seg_dist_m(lat, lon, a, b)
                    if d < best[0]:
                        best = (d, wid)
        return best if best[0] <= limit_m else (None, None)


def main():
    # 1) 원본 합치기 (way ID 로 중복 제거)
    ways = {}
    src = {}
    for fn in ("q1_railway.json", "q2_prefixed.json", "q3_trail.json"):
        for e in load(fn):
            if e["type"] == "way":
                ways.setdefault(e["id"], e)
                src.setdefault(e["id"], set()).add(fn[:2])
    print("고유 way", len(ways))

    items = []
    for wid, e in ways.items():
        tags = e.get("tags", {})
        cat, was = classify(tags)
        near_only = False
        if cat is None:
            # q3 에서만 나온 것: 폐선 태그 없이 폐선 근처 30 m 에 있는 보행·자전거 터널
            if tags.get("highway") in TRAIL_HW and is_tunnel(tags):
                cat, was, near_only = "trail", None, True
            else:
                continue
        geom = [(p["lat"], p["lon"]) for p in e["geometry"]]
        mid = geom[len(geom) // 2]
        items.append({
            "id": wid, "cat": cat, "was_status": was, "near_only": near_only, "tunnel": is_tunnel(tags),
            "km": length_km(geom), "mid": mid, "geom": geom, "pk": [(round(p[0], 6), round(p[1], 6)) for p in geom], "tags": tags,
            "region": region_of(*mid), "metro": metro_of(*mid),
        })
    cats = ["abandoned", "disused", "construction", "proposed", "razed", "trail", "operating_with_prefix"]

    # 2) 분류별 집계
    summary = {}
    for c in cats:
        allw = [i for i in items if i["cat"] == c]
        tun = [i for i in allw if i["tunnel"]]
        reg = Counter()
        regkm = Counter()
        for i in tun:
            reg[i["region"]] += 1
            regkm[i["region"]] += i["km"]
        summary[c] = {
            "ways_all": len(allw), "km_all": round(sum(i["km"] for i in allw), 2),
            "tunnel_ways": len(tun), "tunnel_km": round(sum(i["km"] for i in tun), 2),
            "tunnel_by_region": {r: {"ways": reg[r], "km": round(regkm[r], 2)} for r, _ in regkm.most_common()},
        }
        print(c, summary[c]["ways_all"], summary[c]["km_all"], summary[c]["tunnel_ways"], summary[c]["tunnel_km"])
    trail_sub = Counter()
    for i in items:
        if i["cat"] == "trail":
            trail_sub["near_only(폐선 태그 없음)" if i["near_only"] else "폐선태그+highway"] += 1
    summary["trail"]["split"] = dict(trail_sub)

    # 3) 터널 way 를 노드 공유로 이어 붙인 '터널 덩어리'(같은 분류끼리)
    tun_items = [i for i in items if i["tunnel"] and i["cat"] != "operating_with_prefix"]
    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    owner = {}
    for i in tun_items:
        for n in (i["pk"][0], i["pk"][-1]):  # 끝점(좌표)에서만 잇는다
            k = (i["cat"], n)
            if k in owner:
                parent[find(i["id"])] = find(owner[k])
            else:
                owner[k] = i["id"]
        find(i["id"])
    groups = defaultdict(list)
    for i in tun_items:
        groups[find(i["id"])].append(i)
    chains = []
    for g in groups.values():
        g.sort(key=lambda i: -i["km"])
        top = g[0]
        names = Counter(name_of(i["tags"]) for i in g if name_of(i["tags"]))
        chains.append({
            "category": top["cat"], "ways": [i["id"] for i in g], "n_ways": len(g),
            "km": round(sum(i["km"] for i in g), 3),
            "name": names.most_common(1)[0][0] if names else "",
            "region": top["region"], "metro": top["metro"],
            "center": [round(top["mid"][0], 5), round(top["mid"][1], 5)],
            "line_tags": {k: top["tags"][k] for k in ("name", "old_name", "ref", "operator", "description", "note",
                                                       "railway", "abandoned:railway", "disused:railway", "highway",
                                                       "construction", "opening_date", "start_date", "usage",
                                                       "access", "foot", "bicycle", "wikidata", "wikipedia", "source")
                          if k in top["tags"]},
            "geom": [[round(p[0], 5), round(p[1], 5)] for p in simplify(top["geom"])],
        })
    chains.sort(key=lambda c: -c["km"])
    print("터널 덩어리", len(chains))

    # 4) 공사중: 노선별 터널 km (이름 → 없으면 ref/operator → 부모 relation)
    rels = {}
    for fn in ("q4_constr_rels.json", "q5_trail_rels.json"):
        for e in load(fn):
            if e["type"] == "relation":
                rels[e["id"]] = e
    way_rel = defaultdict(list)
    for r in rels.values():
        for m in r.get("members", []):
            if m["type"] == "way":
                way_rel[m["ref"]].append(r["id"])

    def rel_label(r):
        t = r["tags"]
        return t.get("name") or t.get("ref") or t.get("route") or str(r["id"])

    constr = defaultdict(lambda: {"tunnel_km": 0.0, "tunnel_ways": 0, "all_km": 0.0, "dates": set(), "ways": 0})
    for i in items:
        if i["cat"] != "construction":
            continue
        t = i["tags"]
        rl = [rel_label(rels[r]) for r in way_rel.get(i["id"], []) if rels[r]["tags"].get("type") == "route"]
        label = " | ".join(sorted(set(rl))) if rl else (name_of(t) or t.get("operator", "") or "(이름·노선 없음)")
        c = constr[label]
        c["ways"] += 1
        c["all_km"] += i["km"]
        if i["tunnel"]:
            c["tunnel_km"] += i["km"]
            c["tunnel_ways"] += 1
        for k in ("opening_date", "start_date", "construction:opening_date", "end_date"):
            if k in t:
                c["dates"].add(k + "=" + t[k])
    constr_out = []
    for label, c in constr.items():
        constr_out.append({"line": label, "ways": c["ways"], "all_km": round(c["all_km"], 2),
                           "tunnel_ways": c["tunnel_ways"], "tunnel_km": round(c["tunnel_km"], 2),
                           "dates": sorted(c["dates"])})
    constr_out.sort(key=lambda c: -c["tunnel_km"])
    # 공사중 날짜 태그 빈도
    date_tags = Counter()
    for i in items:
        if i["cat"] == "construction":
            for k in ("opening_date", "start_date", "construction:opening_date", "end_date", "construction"):
                if k in i["tags"]:
                    date_tags[k] += 1

    # 5) 연결: 운행선과 노드 공유 / 50 m 이내
    with open("data/derived/ways_kr.json", encoding="utf-8") as f:
        op = json.load(f)
    op_nodes = {}
    for w in op:
        for p in w["geom"]:  # out geom 에는 노드 ID 가 없어 좌표(소수 6자리)로 노드 공유를 판정한다
            op_nodes.setdefault((p[0], p[1]), w["id"])
    idx = SegIndex()
    for w in op:
        idx.add(w["id"], w["geom"])
    op_by_id = {w["id"]: w for w in op}
    conn_rows = []
    for i in tun_items:
        if i["cat"] in ("construction", "proposed"):
            continue
        shared = [n for n in i["pk"] if n in op_nodes]
        ends = [i["geom"][0], i["geom"][-1]]
        end_near = [idx.nearest(p[0], p[1], 50) for p in ends]
        any_near = None
        for p in i["geom"]:
            d, wid = idx.nearest(p[0], p[1], 50)
            if d is not None and (any_near is None or d < any_near[0]):
                any_near = (d, wid)
        conn_rows.append({"id": i["id"], "cat": i["cat"], "km": i["km"], "region": i["region"], "metro": i["metro"],
                          "shared": bool(shared), "end_near": [e[0] is not None for e in end_near],
                          "any_near": any_near, "tags": i["tags"], "mid": i["mid"]})
    conn = {}
    for c in ["abandoned", "disused", "trail", "razed"]:
        rows = [r for r in conn_rows if r["cat"] == c]
        conn[c] = {
            "tunnel_ways": len(rows),
            "shared_node": sum(r["shared"] for r in rows),
            "any_vertex_within_50m": sum(1 for r in rows if r["any_near"]),
            "any_vertex_within_50m_or_shared": sum(1 for r in rows if r["any_near"] or r["shared"]),
            "one_end_within_50m": sum(1 for r in rows if any(r["end_near"])),
            "both_ends_within_50m": sum(1 for r in rows if all(r["end_near"])),
            "in_metro": sum(1 for r in rows if r["metro"]),
            "in_metro_and_near_or_shared": sum(1 for r in rows if r["metro"] and (r["any_near"] or r["shared"])),
            "in_metro_both_ends": sum(1 for r in rows if r["metro"] and all(r["end_near"])),
        }
    linking = []
    for r in conn_rows:
        if r["metro"] and (r["any_near"] or r["shared"]):
            near_w = op_by_id.get(r["any_near"][1]) if r["any_near"] else None
            linking.append({"id": r["id"], "cat": r["cat"], "km": round(r["km"], 3), "metro": r["metro"],
                            "name": name_of(r["tags"]), "end_near": r["end_near"], "shared": r["shared"],
                            "near_dist_m": round(r["any_near"][0], 1) if r["any_near"] else None,
                            "near_op_way": (near_w["tags"].get("name", "") + " " + near_w["cls"]) if near_w else None,
                            "mid": [round(r["mid"][0], 5), round(r["mid"][1], 5)]})
    linking.sort(key=lambda x: -x["km"])
    both_end_metro = [x for x in linking if all(x["end_near"])]

    # 6) 접근 태그 빈도 (터널 way 기준)
    access = {}
    for c in ["abandoned", "disused", "trail", "construction", "proposed", "razed"]:
        rows = [i for i in tun_items if i["cat"] == c]
        cnt = {}
        for k in ACCESS_KEYS:
            cnt[k] = sum(1 for i in rows if k in i["tags"])
        vals = {}
        for k in ("access", "foot", "bicycle", "highway", "usage"):
            vc = Counter(i["tags"][k] for i in rows if k in i["tags"])
            if vc:
                vals[k] = dict(vc.most_common(8))
        access[c] = {"tunnel_ways": len(rows), "tag_counts": cnt, "values": vals,
                     "named": sum(1 for i in rows if name_of(i["tags"])),
                     "with_wikidata": sum(1 for i in rows if "wikidata" in i["tags"])}
    # 폐선·휴선 터널 중 highway 태그를 가진 것 (trail 로 이미 분류됨) / 길이 분포
    trail_hw = Counter(i["tags"].get("highway") for i in items if i["cat"] == "trail" and i["tunnel"])
    trail_km_hw = Counter()
    for i in items:
        if i["cat"] == "trail" and i["tunnel"]:
            trail_km_hw[i["tags"].get("highway")] += i["km"]
    # 관련 relation(자전거길 등) 이름
    trail_rel = Counter()
    for i in items:
        if i["cat"] == "trail":
            for r in way_rel.get(i["id"], []):
                t = rels[r]["tags"]
                trail_rel[(t.get("route", t.get("type", "")), t.get("name", ""))] += 1
    # 터널 길이 분포
    def bins(cat):
        b = Counter()
        for i in tun_items:
            if i["cat"] == cat:
                k = i["km"]
                b["<0.1"] += k < 0.1
                b["0.1-0.5"] += 0.1 <= k < 0.5
                b["0.5-1"] += 0.5 <= k < 1
                b[">=1"] += k >= 1
        return dict(b)
    out = {
        "method": __doc__ if False else "scripts\\abandoned_check.py 머리말 참고",
        "inputs": {"unique_ways": len(ways), "items_counted": len(items)},
        "summary": summary,
        "length_bins_km": {c: bins(c) for c in ["abandoned", "disused", "trail", "construction"]},
        "trail_by_highway": {k: {"ways": v, "km": round(trail_km_hw[k], 2)} for k, v in trail_hw.most_common()},
        "trail_relations": [{"route": a, "name": b, "ways": n} for (a, b), n in trail_rel.most_common(30)],
        "construction_by_line": constr_out,
        "construction_date_tags": dict(date_tags),
        "connectivity": conn,
        "metro_linking_candidates": linking[:60],
        "metro_linking_both_ends_near": both_end_metro,
        "access_signals": access,
        "longest_tunnels_overall": chains[:20],
        "longest_by_category": {c: [x for x in chains if x["category"] == c][:10]
                                for c in ["abandoned", "disused", "trail", "construction", "proposed", "razed"]},
        "tunnels": [{"id": i["id"], "cat": i["cat"], "was_status": i["was_status"], "km": round(i["km"], 4),
                     "name": name_of(i["tags"]), "region": i["region"], "metro": i["metro"],
                     "mid": [round(i["mid"][0], 5), round(i["mid"][1], 5)],
                     "geom": [[round(p[0], 5), round(p[1], 5)] for p in simplify(i["geom"], 3)],
                     "tags": {k: v for k, v in i["tags"].items() if k in
                              ("name", "ref", "operator", "railway", "highway", "tunnel", "access", "foot", "bicycle",
                               "usage", "note", "description", "opening_date", "start_date", "construction",
                               "abandoned:railway", "disused:railway", "construction:railway")}}
                    for i in sorted(tun_items, key=lambda i: -i["km"])],
    }
    with open("data/derived/abandoned_check.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("연결", json.dumps(conn, ensure_ascii=False))
    print("완료")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
