# measure.py
# 하는 일: ways_kr.json(merge_ways.py 결과)과 노선 relation(routes.json)으로 다음 표를 만든다.
#   1) 철도 종류별 구조(터널/교량/태그 없는 지하/지상) 길이 — 본선과 측선(yard·siding·spur·crossover)을 나눠서
#   2) 시·도별 구조 길이(본선만)
#   3) 노선 relation별 터널 비율, relation이 덮는 비율(완성도)
# 결과는 <출력폴더>에 CSV와 summary.json 으로 쓴다. 길이는 선로 길이(복선을 두 줄로 그렸으면 두 번 센다)다.
# 사용법: python -I scripts\measure.py <ways_kr.json> <routes.json> <출력폴더>
import csv
import json
import os
import sys
from collections import defaultdict

CLASSES = ["tunnel", "bridge", "underground_notag", "surface"]


def write_csv(path, header, rows):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def by_class(ways):
    km = defaultdict(float)
    for w in ways:
        km[w["cls"]] += w["km"]
    total = sum(km.values())
    return total, km


def row(label, ways):
    total, km = by_class(ways)
    # 지하비율은 tunnel 태그만으로 계산한다. layer<0만 있는 선로는 지상 선로에 잘못 붙은 경우가
    # 확인돼(경부선 금정~수원) 지하로 치지 않고 따로 열(태그없는지하km)로만 보여 준다.
    share = km["tunnel"] / total * 100 if total else 0
    return [label, len(ways), round(total, 1)] + [round(km[c], 1) for c in CLASSES] + [round(share, 1)]


HEAD = ["구분", "way수", "총km", "터널km", "교량km", "태그없는지하km", "지상km", "터널비율%"]


def main():
    ways_file, routes_file, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(ways_file, encoding="utf-8") as f:
        ways = json.load(f)
    with open(routes_file, encoding="utf-8") as f:
        routes = [e for e in json.load(f)["elements"] if e["type"] == "relation"]
    main_ways = [w for w in ways if not w["service_side"]]
    side_ways = [w for w in ways if w["service_side"]]
    summary = {}

    # 1) 종류별 (본선 / 측선)
    rows = []
    for rt in ["rail", "subway", "light_rail", "monorail", "narrow_gauge"]:
        rows.append(row(rt + " 본선", [w for w in main_ways if w["railway"] == rt]))
        rows.append(row(rt + " 측선", [w for w in side_ways if w["railway"] == rt]))
    rows.append(row("전체 본선", main_ways))
    rows.append(row("전체 측선", side_ways))
    write_csv(os.path.join(out_dir, "by_type.csv"), HEAD, rows)
    summary["by_type"] = rows

    # 1-1) 세부 태그값별 길이 (tunnel=yes / building_passage / 기타, bridge=yes / viaduct / 기타 ...)
    sub = defaultdict(float)
    for w in main_ways:
        sub[(w["cls"], w["sub"])] += w["km"]
    sub_rows = sorted([[c, s, round(k, 1)] for (c, s), k in sub.items()], key=lambda r: -r[2])
    write_csv(os.path.join(out_dir, "by_subtag.csv"), ["대분류", "세부값", "본선km"], sub_rows)
    summary["by_subtag"] = sub_rows

    # 2) 시·도별 (본선, 모든 종류 / 도시철도류만)
    regions = sorted({w["region"] for w in ways})
    rrows = []
    for rg in regions:
        rw = [w for w in main_ways if w["region"] == rg]
        urban = [w for w in rw if w["railway"] != "rail"]
        rrows.append(row(rg, rw) + row("", urban)[2:])
    write_csv(os.path.join(out_dir, "by_region.csv"),
              HEAD + ["도시철도류 총km", "터널km", "교량km", "태그없는지하km", "지상km", "터널비율%"], rrows)
    summary["by_region"] = rrows

    # 3) 노선 relation별
    way_by_id = {w["id"]: w for w in ways}
    in_route = set()
    lrows = []
    for r in routes:
        t = r.get("tags", {})
        members = [way_by_id[m["ref"]] for m in r["members"] if m["type"] == "way" and m["ref"] in way_by_id]
        tracks = [w for w in members if w["railway"] in ("rail", "subway", "light_rail", "monorail", "narrow_gauge")]
        in_route.update(w["id"] for w in tracks)
        nonway = sum(1 for m in r["members"] if m["type"] == "way" and m["ref"] not in way_by_id)
        lab = f'{t.get("route","")}|{t.get("network","")}|{t.get("ref","")}|{t.get("name","")}'
        lrows.append([r["id"]] + row(lab, tracks) + [nonway, t.get("operator", ""), t.get("from", ""), t.get("to", "")])
    lrows.sort(key=lambda x: x[1])
    write_csv(os.path.join(out_dir, "by_route_relation.csv"),
              ["relation_id"] + HEAD + ["범위밖/측선외 way수", "operator", "from", "to"], lrows)
    summary["route_relation_count"] = len(routes)

    # 3-1) relation 완성도: 본선 길이 중 어떤 노선 relation에라도 들어 있는 비율
    crow = []
    for rt in ["rail", "subway", "light_rail", "monorail"]:
        for rg in regions + ["(전국)"]:
            ws = [w for w in main_ways if w["railway"] == rt and (rg == "(전국)" or w["region"] == rg)]
            tot = sum(w["km"] for w in ws)
            if tot < 1:
                continue
            cov = sum(w["km"] for w in ws if w["id"] in in_route)
            crow.append([rt, rg, round(tot, 1), round(cov, 1), round(cov / tot * 100, 1)])
    write_csv(os.path.join(out_dir, "route_coverage.csv"), ["종류", "시·도", "본선km", "relation포함km", "포함비율%"], crow)
    summary["route_coverage"] = crow

    # 3-2) way 자체의 name 태그로 본 노선(relation이 없어도 쓸 수 있는지 보기 위해)
    named = defaultdict(list)
    for w in main_ways:
        if w["railway"] != "rail":
            named[w["tags"].get("name", "(name 없음)")].append(w)
    nrows = sorted([row(n, ws) for n, ws in named.items()], key=lambda r: -r[2])
    write_csv(os.path.join(out_dir, "by_way_name_urban.csv"), HEAD, nrows)
    summary["urban_way_name_count"] = len(named)

    with open(os.path.join(out_dir, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    for r in rows:
        print(r)
    print()
    for r in rrows:
        print(r)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
