# long_tunnels.py
# 하는 일: 이름과 상관없이, 이어진 터널 선로(본선만)를 사슬로 묶어 긴 것부터 나열한다.
#   이름 태그가 없는 터널(예: 율현터널, 대관령터널)을 위치로 찾아내는 데 쓴다.
#   측선(crossover 등)은 빼서, 복선의 두 선로가 건넘선 하나로 합쳐지지 않게 한다.
# 사용법: python -I scripts\long_tunnels.py <ways_kr.json> <출력.csv> [최소km=5]
import csv
import json
import sys
from collections import defaultdict


def main():
    ways_file, out_file = sys.argv[1], sys.argv[2]
    min_km = float(sys.argv[3]) if len(sys.argv) > 3 else 5.0
    with open(ways_file, encoding="utf-8") as f:
        ways = [w for w in json.load(f) if w["cls"] == "tunnel" and not w["service_side"]]
    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for w in ways:
        for n in w["nodes"][1:]:
            parent[find(n)] = find(w["nodes"][0])
    groups = defaultdict(list)
    for w in ways:
        groups[find(w["nodes"][0])].append(w)
    rows = []
    for g in groups.values():
        km = sum(w["km"] for w in g)
        if km < min_km:
            continue
        names = sorted({w["tags"].get("tunnel:name") or "" for w in g} - {""})
        lines = sorted({w["tags"].get("name", "") for w in g} - {""})
        start, end = g[0]["geom"][0], g[-1]["geom"][-1]
        rows.append([round(km, 2), len(g), "|".join(names), "|".join(lines), g[0]["railway"], g[0]["region"],
                     start[0], start[1], end[0], end[1], " ".join(str(w["id"]) for w in g)])
    rows.sort(key=lambda r: -r[0])
    with open(out_file, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["km", "way수", "tunnel:name", "선로name", "railway", "시·도", "시작lat", "시작lon", "끝lat", "끝lon", "way_ids"])
        w.writerows(rows)
    for r in rows[:40]:
        print(r[:10])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
