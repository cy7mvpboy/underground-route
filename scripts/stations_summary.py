# stations_summary.py
# 하는 일: 역 데이터(stations.json)와 개수 조회(counts.json)를 요약한다.
#   - 역 종류(station=subway/train/light_rail/...)별 개수
#   - 길찾기에 쓸 태그가 얼마나 채워졌는지(name, name:en, 지하 여부 location/level/layer, network, operator, ref)
#   - 출입구(subway_entrance), stop_area, stop_area_group, 노선 relation 개수
#   - 선로(본선) way에 노선 이름(name) 태그가 붙은 비율
# 사용법: python -I scripts\stations_summary.py <stations.json> <counts.json> <ways_kr.json> <출력.json>
import json
import sys
from collections import Counter

COUNT_LABELS = ["railway=construction", "railway=proposed", "railway=abandoned", "railway=disused", "railway=razed",
                "railway=tram", "railway=subway_entrance", "railway=train_station_entrance",
                "public_transport=stop_area", "public_transport=stop_area_group",
                "route relation(subway|train|light_rail|monorail|tram|railway)", "route_master relation"]


def main():
    st_file, counts_file, ways_file, out_file = sys.argv[1:5]
    with open(st_file, encoding="utf-8") as f:
        st = json.load(f)["elements"]
    with open(counts_file, encoding="utf-8") as f:
        counts = [int(e["tags"]["total"]) for e in json.load(f)["elements"]]
    with open(ways_file, encoding="utf-8") as f:
        ways = [w for w in json.load(f) if not w["service_side"]]

    # 역: railway=station|halt 인 것만 센다(public_transport=station만 있는 중복 객체는 따로 센다)
    rs = [e for e in st if e["tags"].get("railway") in ("station", "halt")]
    kinds = Counter(e["tags"].get("station", "(station 태그 없음)") for e in rs)
    fill = {}
    for key in ["name", "name:en", "location", "level", "layer", "network", "operator", "ref", "railway:ref", "wikidata"]:
        fill[key] = round(sum(1 for e in rs if key in e["tags"]) / len(rs) * 100, 1)
    underground = sum(1 for e in rs if e["tags"].get("location") == "underground" or e["tags"].get("level", "0").startswith("-"))

    named = Counter()
    for w in ways:
        named[(w["railway"], "name" in w["tags"])] += w["km"]
    name_share = {}
    for rt in ["rail", "subway", "light_rail", "monorail"]:
        tot = named[(rt, True)] + named[(rt, False)]
        if tot:
            name_share[rt] = round(named[(rt, True)] / tot * 100, 1)

    out = {
        "railway=station|halt 개수": len(rs),
        "public_transport=station만 있는 객체": len(st) - len(rs),
        "station 태그별": dict(kinds.most_common()),
        "태그 채움 비율%": fill,
        "지하역 표시(location=underground 또는 level<0) 개수": underground,
        "개수 조회": dict(zip(COUNT_LABELS, counts)),
        "본선 길이 중 way name 태그가 있는 비율%": name_share,
    }
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
