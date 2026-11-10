# merge_ways.py
# 하는 일: 타일별로 받은 철도 선로(way) 파일을 하나로 합치고(중복 제거), 각 선로에
#   - 길이(km, 하버사인 공식),
#   - 구조 분류(터널 / 교량 / 태그 없는 지하 / 지상),
#   - 시·도(가운데 노드가 속한 시·도, 없으면 노드 다수결)
# 를 붙여 data\derived\ways_kr.json 으로 저장한다. 어느 시·도에도 속하지 않는 선로(북한·일본 등)는 뺀다.
# 사용법: python -I scripts\merge_ways.py <region_nodes1.json,region_nodes2.json> <출력.json> <ways_타일1.json> [타일2 ...]
#   (시·도 파일은 쉼표로 여러 개를 줄 수 있다. 2026년 OSM의 '전남광주통합특별시'는 따로 받았다.)
import json
import math
import sys
from collections import Counter

RAIL_TYPES = {"rail", "subway", "light_rail", "monorail", "narrow_gauge"}
SERVICE_SIDE = {"yard", "siding", "spur", "crossover"}  # 차량기지·측선 등 본선이 아닌 선로


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def way_length_km(geom):
    return sum(haversine_km(a["lat"], a["lon"], b["lat"], b["lon"]) for a, b in zip(geom, geom[1:]))


def layer_value(tags):
    try:
        return float(tags.get("layer", "0").split(";")[0])
    except ValueError:
        return 0.0


def classify(tags):
    """선로 하나의 구조를 (대분류, 세부값)으로 돌려준다."""
    t = tags.get("tunnel")
    if t and t != "no":
        return "tunnel", t if t in ("yes", "building_passage") else "other:" + t
    b = tags.get("bridge")
    if b and b != "no":
        return "bridge", b if b in ("yes", "viaduct") else "other:" + b
    if tags.get("location") == "underground" or layer_value(tags) < 0:
        return "underground_notag", "location=underground" if tags.get("location") == "underground" else "layer<0"
    return "surface", ""


def load_region_map(paths):
    """region_nodes*.json: 시·도 relation(태그) 다음에 그 안의 노드 ID들이 이어진다."""
    elements = []
    for path in paths.split(","):
        with open(path, encoding="utf-8") as f:
            elements += json.load(f)["elements"]
    node_region, current = {}, None
    for e in elements:
        if e["type"] == "relation":
            current = e["tags"].get("name", str(e["id"]))
        elif e["type"] == "node":
            node_region[e["id"]] = current
    return node_region


def pick_region(nodes, node_region):
    mid = node_region.get(nodes[len(nodes) // 2])
    if mid:
        return mid, "midpoint"
    votes = Counter(node_region[n] for n in nodes if n in node_region)
    if votes:
        return votes.most_common(1)[0][0], "majority"
    return None, "outside"


def main():
    region_file, out_file, tile_files = sys.argv[1], sys.argv[2], sys.argv[3:]
    node_region = load_region_map(region_file)
    ways = {}
    for tf in tile_files:
        with open(tf, encoding="utf-8") as f:
            for e in json.load(f)["elements"]:
                if e["type"] == "way" and e.get("tags", {}).get("railway") in RAIL_TYPES:
                    ways[e["id"]] = e  # 타일 경계에 걸친 선로는 여러 타일에 나오므로 ID로 중복 제거
    out, dropped, how = [], 0, Counter()
    for wid, e in ways.items():
        region, method = pick_region(e["nodes"], node_region)
        how[method] += 1
        if region is None:
            dropped += 1
            continue
        tags = e["tags"]
        cls, sub = classify(tags)
        out.append({
            "id": wid,
            "railway": tags["railway"],
            "service_side": tags.get("service") in SERVICE_SIDE,
            "cls": cls,
            "sub": sub,
            "km": round(way_length_km(e["geometry"]), 5),
            "region": region,
            "tags": tags,
            "nodes": e["nodes"],
            "geom": [[round(p["lat"], 6), round(p["lon"], 6)] for p in e["geometry"]],
        })
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"타일 합계(중복 제거) {len(ways)}개, 한국 안 {len(out)}개, 국외로 제외 {dropped}개")
    print("시·도 판정 방법:", dict(how))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
