# han_crossings.py
# 하는 일: 한강 중심선과 교차하는 철도 선로를 모두 찾아, 교차 지점마다 터널(강 밑)인지 교량인지 적는다.
#   - 선분 교차 판정은 평면(위경도) 기준이다. 서울 범위에서는 이 정도로 충분하다.
#   - 같은 곳에서 여러 선로(상·하행, 측선)가 건너면 400m 안의 교차점을 한 '횡단 지점'으로 묶는다.
#   - 선로가 속한 노선 relation 이름도 붙인다.
# 사용법: python -I scripts\han_crossings.py <ways_kr.json> <han_river.json> <routes.json> <출력.json>
import json
import math
import sys


def seg_cross(p1, p2, q1, q2):
    """선분 p1-p2와 q1-q2가 만나면 교차점(lat, lon)을, 아니면 None을 돌려준다."""
    (y1, x1), (y2, x2), (y3, x3), (y4, x4) = p1, p2, q1, q2
    d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
    if d == 0:
        return None
    t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
    u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
    if 0 <= t <= 1 and 0 <= u <= 1:
        return (y1 + t * (y2 - y1), x1 + t * (x2 - x1))
    return None


def dist_m(a, b):
    return math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0])))


def main():
    ways_file, river_file, routes_file, out_file = sys.argv[1:5]
    with open(ways_file, encoding="utf-8") as f:
        ways = json.load(f)
    with open(river_file, encoding="utf-8") as f:
        river = [[(p["lat"], p["lon"]) for p in e["geometry"]] for e in json.load(f)["elements"] if e["type"] == "way"]
    with open(routes_file, encoding="utf-8") as f:
        routes = [e for e in json.load(f)["elements"] if e["type"] == "relation"]
    route_names = {}
    for r in routes:
        nm = r.get("tags", {}).get("name", str(r["id"]))
        for m in r["members"]:
            if m["type"] == "way":
                route_names.setdefault(m["ref"], set()).add(nm)
    river_segs = [(a, b) for line in river for a, b in zip(line, line[1:])]
    lat_min = min(p[0] for line in river for p in line)
    lat_max = max(p[0] for line in river for p in line)

    hits = []
    for w in ways:
        g = [tuple(p) for p in w["geom"]]
        if max(p[0] for p in g) < lat_min or min(p[0] for p in g) > lat_max:
            continue
        for a, b in zip(g, g[1:]):
            for q1, q2 in river_segs:
                pt = seg_cross(a, b, q1, q2)
                if pt:
                    t = w["tags"]
                    hits.append({
                        "way": w["id"], "pt": [round(pt[0], 5), round(pt[1], 5)], "railway": w["railway"],
                        "cls": w["cls"], "sub": w["sub"], "service": t.get("service", ""), "layer": t.get("layer", ""),
                        "name": t.get("name", ""), "bridge:name": t.get("bridge:name", ""),
                        "tunnel:name": t.get("tunnel:name", ""), "region": w["region"],
                        "routes": sorted(route_names.get(w["id"], [])),
                    })
    # 400m 안의 교차점을 한 횡단 지점으로 묶는다
    sites = []
    for h in sorted(hits, key=lambda h: h["pt"][1]):
        for s in sites:
            if dist_m(s["pt"], h["pt"]) < 400:
                s["ways"].append(h)
                break
        else:
            sites.append({"pt": h["pt"], "ways": [h]})
    for s in sites:
        s["구조"] = sorted({h["cls"] for h in s["ways"]})
        s["names"] = sorted({h["bridge:name"] or h["tunnel:name"] or h["name"] for h in s["ways"]} - {""})
        s["routes"] = sorted({r for h in s["ways"] for r in h["routes"]})
        print(s["pt"], s["구조"], s["names"][:3], s["routes"][:4], "ways", [h["way"] for h in s["ways"]])
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(sites, f, ensure_ascii=False, indent=1)
    print("횡단 지점", len(sites), "개, 교차 선로", len(hits), "개")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
