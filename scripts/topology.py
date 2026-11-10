# topology.py
# 하는 일: OSM 선로가 노드 ID를 공유해 실제로 이어져 있는지(위상) 대략 점검한다.
#   - 지정한 시·도들의 선로만 골라 그래프를 만들고(같은 노드 ID를 쓰면 연결), 연결 요소(component) 개수를 센다.
#   - 터널(+태그 없는 지하)만 뽑은 부분 그래프의 연결 요소도 센다.
#   - 끊긴 곳 후보: 다른 선로와 공유하지 않는 끝점(막다른 끝) 중, 3m 안에 다른 선로의 노드가 있는 것
#     (= 그림으로는 붙어 보이지만 노드가 따로 있어 그래프상 끊긴 곳)을 센다.
# 사용법: python -I scripts\topology.py <ways_kr.json> <출력.json>
import json
import math
import sys
from collections import defaultdict

SYSTEMS = {
    # 이름: (시·도 목록, 포함할 railway 종류)
    "수도권 subway": (["서울특별시", "경기도", "인천광역시"], {"subway"}),
    "수도권 전체 철도(rail 포함)": (["서울특별시", "경기도", "인천광역시"], {"subway", "rail", "light_rail", "monorail"}),
    "부산 subway(+경남 양산)": (["부산광역시", "경상남도"], {"subway"}),
    "부산·경남 전체 철도": (["부산광역시", "경상남도"], {"subway", "rail", "light_rail", "monorail"}),
    "대구 subway·monorail": (["대구광역시", "경상북도"], {"subway", "monorail"}),
}


def components(ways):
    """노드 ID를 공유하는 선로끼리 묶는다(유니온-파인드). 묶음마다 [선로 수, km]를 돌려준다."""
    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for w in ways:
        first = find(w["nodes"][0])
        for n in w["nodes"][1:]:
            parent[find(n)] = first
    groups = defaultdict(lambda: [0, 0.0])
    for w in ways:
        g = groups[find(w["nodes"][0])]
        g[0] += 1
        g[1] += w["km"]
    return sorted(groups.values(), key=lambda g: -g[1])


def near_miss_gaps(ways, metres=3.0):
    """막다른 끝점인데 근처(3m)에 다른 선로 노드가 있는 곳 = 노드가 공유되지 않아 끊긴 곳 후보."""
    use = defaultdict(int)  # 노드가 몇 개의 선로에서 쓰이는지(끝점 판정용)
    coord = {}
    for w in ways:
        for n, (lat, lon) in zip(w["nodes"], w["geom"]):
            use[n] += 1
            coord[n] = (lat, lon)
    cell = 0.0001  # 약 10m 격자
    grid = defaultdict(list)
    for n, (lat, lon) in coord.items():
        grid[(int(lat / cell), int(lon / cell))].append(n)
    gaps = []
    for w in ways:
        for end in (w["nodes"][0], w["nodes"][-1]):
            if use[end] > 1 or w["nodes"][0] == w["nodes"][-1]:
                continue
            lat, lon = coord[end]
            gx, gy = int(lat / cell), int(lon / cell)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for n in grid[(gx + dx, gy + dy)]:
                        if n == end or n in w["nodes"]:
                            continue
                        la, lo = coord[n]
                        d = math.hypot((la - lat) * 111320, (lo - lon) * 111320 * math.cos(math.radians(lat)))
                        if d <= metres:
                            gaps.append({"way": w["id"], "node": end, "near_node": n, "m": round(d, 2), "lat": lat, "lon": lon})
    return gaps


def sandwiched(ways):
    """양 끝이 모두 터널 선로와만 이어진 '지상' 선로(본선) = 터널 사이에 낀 의심 구간.
    지하역 구간에 tunnel 태그가 빠진 오류일 수 있다(실제 짧은 지상 구간일 수도 있음)."""
    at = defaultdict(list)
    for w in ways:
        for n in (w["nodes"][0], w["nodes"][-1]):
            at[n].append(w)
    out = []
    for w in ways:
        if w["cls"] in ("tunnel", "underground_notag") or w["service_side"]:
            continue
        sides = []
        for n in (w["nodes"][0], w["nodes"][-1]):
            nb = [x for x in at[n] if x["id"] != w["id"] and not x["service_side"]]
            sides.append(bool(nb) and all(x["cls"] in ("tunnel", "underground_notag") for x in nb))
        if all(sides):
            mid = w["geom"][len(w["geom"]) // 2]
            out.append({"way": w["id"], "cls": w["cls"], "km": round(w["km"], 3), "name": w["tags"].get("name"), "lat": mid[0], "lon": mid[1]})
    return out


def describe(ways):
    comps = components(ways)
    total = sum(c[1] for c in comps)
    return {
        "way수": len(ways),
        "km": round(total, 1),
        "연결요소수": len(comps),
        "가장큰요소km": round(comps[0][1], 1) if comps else 0,
        "1km미만요소수": sum(1 for c in comps if c[1] < 1),
        "상위10요소km": [round(c[1], 1) for c in comps[:10]],
    }


def main():
    ways_file, out_file = sys.argv[1], sys.argv[2]
    with open(ways_file, encoding="utf-8") as f:
        ways = json.load(f)
    result = {}
    for name, (regions, types) in SYSTEMS.items():
        sel = [w for w in ways if w["region"] in regions and w["railway"] in types]
        tunnels = [w for w in sel if w["cls"] in ("tunnel", "underground_notag")]
        # 터널 끝점 중 다른 선로(터널이든 아니든)와 노드를 공유하는 비율
        use = defaultdict(int)
        for w in sel:
            for n in w["nodes"]:
                use[n] += 1
        ends = [n for w in tunnels for n in (w["nodes"][0], w["nodes"][-1])]
        shared = sum(1 for n in ends if use[n] > 1)
        gaps = near_miss_gaps(sel)
        side = {w["id"] for w in sel if w["service_side"]}
        main_gaps = [g for g in gaps if g["way"] not in side]  # 측선 끝의 차막이끼리 가까운 것은 정상이라 따로 본다
        result[name] = {
            "전체": describe(sel),
            "터널만": describe(tunnels),
            "터널끝점_공유비율%": round(shared / len(ends) * 100, 1) if ends else None,
            "끊긴곳후보(3m내 미공유)": len(gaps),
            "그중_본선": len(main_gaps),
            "본선끊긴곳": main_gaps[:15],
            "터널사이에낀지상선로": sandwiched(sel),
        }
        print(name, json.dumps({k: v for k, v in result[name].items() if k != "끊긴곳예시"}, ensure_ascii=False))
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
