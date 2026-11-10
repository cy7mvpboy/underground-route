# tunnel_check.py
# 하는 일: 이름으로 긴 철도 터널을 찾아 OSM 길이를 잰다.
#   - name / tunnel:name 태그에 키워드가 들어간 선로(way)를 모은다.
#   - 노드를 공유하는 것끼리 이어 '사슬(chain)'로 묶고, 사슬마다 길이를 잰다.
#     복선을 선로 두 줄로 그렸으면 비슷한 길이의 사슬이 두 개 나온다.
# 사용법: python -I scripts\tunnel_check.py <ways_kr.json> <출력.json> <키워드1> [키워드2 ...]
import json
import sys
from collections import defaultdict


def chains(ways):
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
    return sorted(groups.values(), key=lambda g: -sum(w["km"] for w in g))


def main():
    ways_file, out_file, keywords = sys.argv[1], sys.argv[2], sys.argv[3:]
    with open(ways_file, encoding="utf-8") as f:
        ways = json.load(f)
    result = {}
    for kw in keywords:
        hit = [w for w in ways if kw in w["tags"].get("name", "") or kw in w["tags"].get("tunnel:name", "")]
        tun = [w for w in hit if w["cls"] == "tunnel"]
        out = {
            "이름일치_way수": len(hit),
            "그중_터널아님": [{"id": w["id"], "cls": w["cls"], "name": w["tags"].get("name")} for w in hit if w["cls"] != "tunnel"],
            "사슬": [],
        }
        for g in chains(tun):
            out["사슬"].append({
                "km": round(sum(w["km"] for w in g), 3),
                "way수": len(g),
                "way_ids": [w["id"] for w in g],
                "railway": sorted({w["railway"] for w in g}),
                "tracks태그": sorted({w["tags"].get("tracks", "") for w in g}),
                "names": sorted({w["tags"].get("tunnel:name") or w["tags"].get("name", "") for w in g}),
                "예시좌표": g[0]["geom"][0],
            })
        result[kw] = out
        print(kw, "way", len(hit), "| 사슬 km:", [(c["km"], c["way수"]) for c in out["사슬"]])
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
