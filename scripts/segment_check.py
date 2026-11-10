# segment_check.py
# 하는 일: 출처로 확인한 '지상(고가·교량·지상) 구간'과 '지하 구간'이 OSM에서도 그렇게 표시돼 있는지 확인한다.
#   checks.json 의 항목마다
#   - "stations": 역 이름을 순서대로 적으면, 이웃한 두 역 사이 직선 통로(폭 ±W m, 양 끝 10%는 뺌) 안에 있는
#     해당 노선 선로 조각의 길이를 구조별로 더한다.
#   - "near": 역 하나 주변 반경 R m 안의 선로 조각을 본다.
#   - "line": 노선 전체(way name 또는 relation 이름 일치)를 본다.
#   노선 선로 = 본선 중 way의 name 태그나 소속 relation 이름에 "line" 문자열이 들어간 것.
#   판정: expect=above 면 터널(+태그없는 지하) 비율이 30% 미만일 때 일치, expect=under 면 90% 이상일 때 일치.
# 사용법: python -I scripts\segment_check.py <ways_kr.json> <stations.json> <routes.json> <checks.json> <출력.json>
import json
import math
import sys
from collections import defaultdict

UNDER = ("tunnel", "underground_notag")


def xy(p, lat0):
    """위경도 -> 평면 m 좌표 (작은 범위용 근사)."""
    return (p[1] * 111320 * math.cos(math.radians(lat0)), p[0] * 110540)


def seg_len_m(a, b):
    return math.dist(a, b)


def station_coords(stations, names):
    out = []
    for e in stations:
        t = e.get("tags", {})
        if t.get("name") in names or t.get("name:ko") in names:
            c = (e["lat"], e["lon"]) if "lat" in e else (e["center"]["lat"], e["center"]["lon"])
            out.append(c)
    return out


def pick_station(cands, line_pts, lat0):
    """같은 이름 역이 여럿이면 그 노선 선로와 가장 가까운 것을 고른다."""
    best, bestd = None, 1e18
    for c in cands:
        cx = xy(c, lat0)
        d = min(math.dist(cx, p) for p in line_pts)
        if d < bestd:
            best, bestd = c, d
    return best, bestd


def main():
    ways_file, st_file, routes_file, checks_file, out_file = sys.argv[1:6]
    with open(ways_file, encoding="utf-8") as f:
        ways = [w for w in json.load(f) if not w["service_side"]]
    with open(st_file, encoding="utf-8") as f:
        stations = json.load(f)["elements"]
    with open(routes_file, encoding="utf-8") as f:
        routes = [e for e in json.load(f)["elements"] if e["type"] == "relation"]
    with open(checks_file, encoding="utf-8") as f:
        checks = json.load(f)
    rel_names = defaultdict(set)
    for r in routes:
        for m in r["members"]:
            if m["type"] == "way":
                rel_names[m["ref"]].add(r.get("tags", {}).get("name", ""))

    results = []
    for ck in checks:
        key = ck["line"]
        lw = [w for w in ways if key in w["tags"].get("name", "") or any(key in n for n in rel_names[w["id"]])]
        km = defaultdict(float)
        used = set()
        note = ""
        if "stations" in ck or "near" in ck:
            names = ck.get("stations") or [ck["near"]]
            lat0 = 36.5
            pts = [xy(p, lat0) for w in lw for p in w["geom"]]
            if not pts:
                results.append({**ck, "판정": "확인불가", "note": "노선 선로를 찾지 못함"})
                continue
            st = []
            for nm in names:
                alts = nm if isinstance(nm, list) else [nm]
                c, d = pick_station(station_coords(stations, alts), pts, lat0)
                if c is None:
                    note += f"역 없음:{alts} "
                    continue
                st.append(xy(c, lat0))
                if d > 300:
                    note += f"{alts[0]} 역-선로 {d:.0f}m "
            for w in lw:
                g = [xy(p, lat0) for p in w["geom"]]
                for a, b in zip(g, g[1:]):
                    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                    inside = False
                    if "near" in ck and st:
                        inside = math.dist(mid, st[0]) <= ck.get("R", 300)
                    for s1, s2 in zip(st, st[1:]):
                        L = math.dist(s1, s2)
                        t = ((mid[0] - s1[0]) * (s2[0] - s1[0]) + (mid[1] - s1[1]) * (s2[1] - s1[1])) / (L * L)
                        if 0.1 <= t <= 0.9:
                            proj = (s1[0] + t * (s2[0] - s1[0]), s1[1] + t * (s2[1] - s1[1]))
                            if math.dist(mid, proj) <= ck.get("W", 400):
                                inside = True
                    if inside:
                        km[w["cls"]] += seg_len_m(a, b) / 1000
                        used.add(w["id"])
        else:  # 노선 전체
            for w in lw:
                km[w["cls"]] += w["km"]
                used.add(w["id"])
        total = sum(km.values())
        under = sum(km[c] for c in UNDER)
        share = under / total * 100 if total else None
        if share is None:
            verdict = "확인불가"
        elif ck["expect"] == "above":
            verdict = "일치" if share < 30 else "불일치"
        else:
            verdict = "일치" if share >= 90 else "불일치"
        res = {**ck, "OSM_km": round(total, 2), "구조별km": {k: round(v, 2) for k, v in km.items()},
               "지하비율%": None if share is None else round(share, 1), "판정": verdict,
               "way_ids": sorted(used)[:40], "note": note.strip()}
        results.append(res)
        print(f'[{verdict}] {ck["id"]} {ck["desc"]} | OSM {res["OSM_km"]}km 지하 {res["지하비율%"]}% {res["구조별km"]} {note}')
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
