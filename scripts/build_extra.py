# build_extra.py
# 하는 일: 공공데이터 두 가지를 그래프의 역·노선 번호에 맞춰 web\data\extra.json으로 만든다.
#   1) 국토교통부 철도역 빠른 환승 정보(2025-09-23): 역·노선·열차 방향(종착역)마다 환승 계단에 가까운 차량·출입문.
#      → fast[]: 역 번호, 노선 번호, 환승 노선 번호, 그 열차 방향의 '바로 앞 역'(prev), 차량 위치(front/middle/back).
#   2) 서울교통공사 역별 역세권 현황(2026-09-02): 출구마다 주변 지명·시설 이름.
#      → exits{역 번호: {출구 번호: [이름, ...]}} (출구마다 EXIT_NAMES_MAX개까지).
# 사용법(프로젝트 폴더에서): python -I scripts\build_extra.py
# 형식 설명: docs\graph-format.md의 'extra.json' 절.
import gzip
import json
import os
import re
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))  # -I 모드에서도 옆 스크립트를 불러오기 위해
from build_graph import DEPTH_ALIASES, LINE_ALIAS, normalize_name  # noqa: E402
from build_graph import read_cp949_csv as read_csv  # noqa: E402  (CP949, 머리줄 뺀 행 목록)

GRAPH = os.path.join(ROOT, "web", "data", "graph.json")
FAST_CSV = os.path.join(ROOT, "data", "raw", "transfer", "fast_transfer_20250923.csv")
EXIT_CSV = os.path.join(ROOT, "data", "raw", "transfer", "exit_area_20260902.csv")
OUT = os.path.join(ROOT, "web", "data", "extra.json")
OUT_REPORT = os.path.join(ROOT, "data", "derived", "extra_report.json")

SOURCES = [
    {"name": "국토교통부 철도역 빠른 환승 정보", "date": "2025-09-23",
     "url": "https://www.data.go.kr/data/15151816/fileData.do", "license": "이용허락범위 제한 없음"},
    {"name": "서울교통공사 역별 역세권 현황", "date": "2026-09-02",
     "url": "https://www.data.go.kr/data/15044230/fileData.do", "license": "이용허락범위 제한 없음"},
]

# CSV 노선 표기 → 정식 노선 이름(build_graph.py LINE_TABLE). 'N호선'은 운영기관으로 도시를 정한다(OPERATOR_CITY).
CSV_LINE = {
    "경의중앙": "경의중앙선", "수인분당": "수인분당선", "경춘": "경춘선", "경강": "경강선", "동해": "동해선 광역전철",
    "공항철도": "공항철도", "신분당선": "신분당선", "우이신설": "우이신설선", "의정부경전철": "의정부경전철",
    "용인에버라인": "용인경전철", "자기부상": "인천공항 자기부상철도", "인천1호선": "인천 1호선",
    "인천2호선": "인천 2호선", "부산김해경전철": "부산김해경전철",
}
OPERATOR_CITY = {"부산교통공사": "부산 ", "대구교통공사": "대구 "}  # 그 밖의 'N호선'은 수도권(인천교통공사 7호선 포함)

# 편성 길이(량). 일반 지식으로 아는 값만 넣었다(온라인으로 다시 확인하지 않음). 표에 없는 노선은 자료의 최대 차량순서를 쓴다.
# 자료의 차량순서가 이 값보다 크면 그 행은 잘못된 값으로 보고 뺀다(예: 인천 2호선 검암 '6호차' — 인천 2호선은 2량).
KNOWN_CARS = {
    "1호선": 10, "2호선": 10, "3호선": 10, "4호선": 10, "5호선": 8, "6호선": 8, "7호선": 8, "8호선": 6,
    "신분당선": 6, "공항철도": 6, "수인분당선": 6, "경강선": 4,
    "인천 1호선": 8, "인천 2호선": 2, "우이신설선": 2, "의정부경전철": 2, "부산김해경전철": 2, "용인경전철": 1,
    "부산 1호선": 8, "부산 2호선": 6, "대구 1호선": 6, "대구 2호선": 6, "대구 3호선": 3,
}

# 자료의 역 이름 중 OSM(그래프) 이름과 다른 것 → 그래프 이름. build_graph.py의 DEPTH_ALIASES에 더한다.
EXTRA_ALIASES = {
}
ALIASES = {**DEPTH_ALIASES, **EXTRA_ALIASES}

EXIT_NAMES_MAX = 4  # 6개면 출구 부분만 142KB라 4개로 줄였다(119KB)
# 출구 주변 이름 고르기: 자료 순서를 지키되, 6개가 넘으면 잘 알려진 종류부터 남긴다.
#   0순위: 동·가 이름(예: 동자동, 봉래동1가), 1순위: 역·대학·병원·관공서·공원·시장 같은 큰 시설, 2순위: 나머지.
DONG_RE = re.compile(r"^[가-힣]+(\d+)?(동|가)(\d+가)?$")
MAJOR_RE = re.compile(r"(역|대학교|대학|병원|의료원|구청|시청|군청|청사|법원|검찰청|경찰서|소방서|우체국|세무서|"
                      r"주민센터|행정복지센터|공원|시장|백화점|터미널|광장|궁|박물관|미술관|도서관|경기장|체육관|"
                      r"고등학교|중학교|초등학교|학교|공항|아파트|청)$")


def csv_line(operator, name):
    """CSV의 (운영기관, 노선명) → 정식 노선 이름. 모르면 None."""
    name = (name or "").strip()
    if not name:
        return None
    if re.fullmatch(r"\d호선", name):
        return OPERATOR_CITY.get(operator.strip(), "") + name
    return CSV_LINE.get(name) or LINE_ALIAS.get(name)


class Graph:
    def __init__(self, g):
        T = g["tables"]
        self.g, self.lines = g, T["lines"]
        self.line_idx = {l: i for i, l in enumerate(T["lines"])}
        self.st_lines = [sorted({T["lines"][li] for ls in s["hub_ls"] for li in T["line_sets"][ls]}) for s in g["stations"]]
        self.by_name = defaultdict(list)
        for si, s in enumerate(g["stations"]):
            for n in s["names"]:
                self.by_name[n].append(si)
        self.routes = defaultdict(list)  # 노선 번호 → [(정차역 순서, 순환 여부)]
        self.triples = defaultdict(set)  # 노선 번호 → {(앞 역, 역, 다음 역)} (relation에서 이어진 세 정차역)
        self.succ = defaultdict(lambda: defaultdict(set))  # 노선 번호 → 역 → 다음 정차역들
        for r in g["line_routes"]:
            st = r["st"][:-1] if r["loop"] else r["st"]  # 순환: 첫 역 = 마지막 역이므로 하나 뺀다
            loop = bool(r["loop"])
            self.routes[r["l"]].append((st, loop))
            ext = st + st[:2] if loop else st
            for a, b in zip(ext, ext[1:]):
                self.succ[r["l"]][a].add(b)
            for a, b, c in zip(ext, ext[1:], ext[2:]):
                self.triples[r["l"]].add((a, b, c))

    def line_at(self, si, label):
        """역 si에서 노선 label에 맞는 허브 노선 이름(정확히 같은 것 먼저, 없으면 지선 '2호선 성수지선' 등)."""
        lines = self.st_lines[si]
        if label in lines:
            return label
        br = [l for l in lines if l.startswith(label + " ")]
        return br[0] if br else None

    def find(self, name, label):
        """이름(정규화, 옛 이름 표 포함)이 같고 노선 label 허브가 있는 역 번호 목록."""
        for n in (name, ALIASES.get(normalize_name(name), "")):
            key = normalize_name(n)
            if not key:
                continue
            hits = [si for si in self.by_name.get(key, ()) if label is None or self.line_at(si, label)]
            if hits:
                return hits
        return []

    def near_first(self, s, ps):
        """역 목록을 역 s에서 가까운 순으로(중복 제거). 급행 relation의 '건너뛴 앞 역'보다 바로 옆 역이 먼저 오게 한다."""
        S = self.g["stations"]
        d = lambda p: (S[p]["lat"] - S[s]["lat"]) ** 2 + ((S[p]["lon"] - S[s]["lon"]) * 0.8) ** 2
        return sorted(dict.fromkeys(p for p in ps if p is not None and p != s), key=d)

    def adjacent(self, line, a, b):
        """노선 line의 relation에서 a와 b가 이어진 정차역인가."""
        return b in self.succ[line].get(a, ()) or a in self.succ[line].get(b, ())

    def prevs(self, line, s, toward):
        """노선 line에서 toward(종착역) 쪽으로 가는 열차가 역 s 바로 전에 서는 역 목록(가까운 순). 못 찾으면 [].
        1) s 뒤에 toward가 있는 relation의 s 바로 앞 정차역. 순환 relation은 toward까지 정차 수가 적은 방향만 쓴다.
        2) 그런 relation이 s에서 출발하면(앞 역 없음) 그 relation의 s 다음 역(n1)을 두고, 다른 relation에서
           (앞 역, s, n1)으로 이어진 앞 역을 쓴다. relation 하나로 s→toward가 안 되면(지선이 갈리는 곳 등)
           모든 relation을 이은 방향 그래프에서 s→toward 최단 경로의 첫 역을 n1로 쓴다.
        3) toward == s(그 역에서 끝나는 열차)면 s가 종착인 relation(순환 제외)의 바로 앞 역.
        돌려주는 값: (앞 역 목록, origin). origin = 앞 역은 없지만 열차가 s에서 출발한다(s가 relation의 첫 역)는 것을 안다."""
        R = self.routes.get(line, ())
        if toward == s:
            return self.near_first(s, [st[-2] for st, loop in R if not loop and len(st) > 1 and st[-1] == s]), False
        direct, nexts, loop_best, loop_hits = [], set(), None, []
        for st, loop in R:
            n = len(st)
            for i, v in enumerate(st):
                if v != s:
                    continue
                rng = range(1, n) if loop else range(1, n - i)
                d = next((k for k in rng if st[(i + k) % n] == toward), None)
                if d is None:
                    continue
                hit = (st[i - 1] if (loop or i > 0) else None, st[(i + 1) % n])
                if loop:
                    if loop_best is None or d < loop_best:
                        loop_best, loop_hits = d, [hit]
                    elif d == loop_best:
                        loop_hits.append(hit)
                else:
                    direct.append(hit)
        hits = direct + loop_hits
        ps = self.near_first(s, [p for p, _ in hits])
        if ps:
            return ps, False
        nexts = {n1 for _, n1 in hits} or self.first_hops(line, s, toward)
        ps = self.near_first(s, [a for a, b, c in self.triples[line] if b == s and c in nexts])
        return ps, not ps and bool(hits)

    def first_hops(self, line, s, toward):
        """노선 line의 정차역 방향 그래프에서 s→toward 최단 경로(정차 수)의 첫 역들."""
        succ = self.succ[line]
        level = {n1: {n1} for n1 in succ.get(s, ())}  # 이번 단계에 닿은 역 → 거기로 온 첫 역들
        seen, firsts = {s}, set()
        while level:
            for v, fs in level.items():
                if v == toward:
                    firsts |= fs
                seen.add(v)
            if firsts:
                break
            nxt = defaultdict(set)
            for v, fs in level.items():
                for w in succ.get(v, ()):
                    if w not in seen:
                        nxt[w] |= fs
            level = nxt
        return firsts


def car_pos(car, cars):
    """차량 위치: 차량 가운데 (car - 0.5) / cars 가 1/3 미만이면 front, 2/3 초과면 back, 나머지 middle.
    차량 가운데로 재므로 방향을 뒤집어도(car → cars + 1 - car) front ↔ back이 정확히 바뀌고 middle은 그대로다.
    예) 10량: 1~3 front, 4~7 middle, 8~10 back / 8량: 1~3, 4~5, 6~8 / 6량: 1~2, 3~4, 5~6 / 4량: 1, 2~3, 4 / 2량: 1, -, 2."""
    x = (car - 0.5) / cars
    return "front" if x < 1 / 3 else "back" if x > 2 / 3 else "middle"


def build_fast(G, rep):
    out, seen = [], set()
    unmapped = Counter()
    car_max = defaultdict(int)
    rows = read_csv(FAST_CSV)
    rep["fast_rows"] = len(rows)
    parsed = []
    for r in rows:
        op, lname, sname, toward, top, tline, nname, _origin, car, door = [c.strip() for c in r[:10]]
        line, to_line = csv_line(op, lname), csv_line(top, tline)
        if not car.isdigit():
            unmapped[f"차량순서 없음: {lname or '(노선 없음)'} {sname or '(역 없음)'} → {tline}"] += 1
            continue
        if line:
            car_max[line] = max(car_max[line], int(car))
        parsed.append((op, lname, sname, toward, tline, nname, line, to_line, int(car), int(door) if door.isdigit() else None))
    cars_of = {l: KNOWN_CARS.get(l, m) for l, m in car_max.items()}
    rep["cars"] = {l: {"used": cars_of[l], "data_max": car_max[l], "known": KNOWN_CARS.get(l)} for l in sorted(cars_of)}
    n_prev = n_prev_alt = n_ok = n_origin = 0
    dropped = Counter()
    for op, lname, sname, toward, tline, nname, line, to_line, car, door in parsed:
        if not line or not to_line or line not in G.line_idx and not any(l.startswith(line + " ") for l in G.lines):
            unmapped[f"노선 모름: {op} '{lname}' → '{tline}'"] += 1
            continue
        if car > cars_of[line]:
            unmapped[f"차량순서가 편성보다 큼: {line} {sname} {car}호차(편성 {cars_of[line]}량)"] += 1
            continue
        hits = G.find(sname, line)
        if not hits:
            why = "이름 없음" if not G.find(sname, None) else f"{line} 허브 없음"
            unmapped[f"역 모름({why}): {line} '{sname}'"] += 1
            continue
        if len(hits) > 1:
            unmapped[f"역 여럿(첫째 씀): {line} '{sname}'"] += 1
        s = hits[0]
        # 노선 고르기. 같은 노선 표기끼리(예: 2호선 신도림 → 2호선)는 본선 ↔ 지선 환승이다.
        #   환승이후역이 있으면 그 역과 이어진 쪽이 환승 노선, 나머지가 타던 노선이다.
        #   없으면 종착역 쪽 앞 역(prev)을 찾을 수 있는 쪽을 타던 노선으로 본다(지선 먼저).
        nh = G.find(nname, to_line) if nname else []
        if line == to_line:
            group = [l for l in G.st_lines[s] if l.startswith(line + " ")] + [l for l in G.st_lines[s] if l == line]
            to_cand = [l for l in group if any(G.adjacent(G.line_idx[l], s, n) for n in nh)]
            cand = [l for l in group if l not in to_cand[:1]]
        else:  # 정확히 같은 노선 먼저, 그다음 지선(예: 신도림에서 끝나는 신정지선 열차가 '2호선'으로 적힌 행)
            cand = [l for l in G.st_lines[s] if l == line] + [l for l in G.st_lines[s] if l.startswith(line + " ")]
        th = G.find(toward, line) if toward else []
        chosen = None
        for lname_c in cand:
            for t in th:
                p, origin = G.prevs(G.line_idx[lname_c], s, t)
                if p or origin:
                    chosen = (lname_c, p, origin)
                    break
            if chosen:
                break
        my_line, prevs, origin = chosen or (cand[0] if cand else None, [], False)
        if my_line is None:
            unmapped[f"노선 번호 없음: {line} '{sname}'"] += 1
            continue
        if line == to_line:
            others = [l for l in group if l != my_line]
            if not others:
                unmapped[f"같은 노선 환승인데 지선 없음: {line} '{sname}'"] += 1
                continue
            to_name = others[0]
        else:
            to_name = G.line_at(s, to_line) or to_line
        if to_name not in G.line_idx:
            unmapped[f"환승 노선 번호 없음: '{to_name}'"] += 1
            continue
        if not G.line_at(s, to_name):
            rep.setdefault("no_to_hub", Counter())[f"{sname} {to_name}"] += 1
        cars = cars_of[line]
        pos = car_pos(car, cars)
        e = {"s": s, "line": G.line_idx[my_line], "to_line": G.line_idx[to_name],
             "prev": prevs[0] if prevs else None, "toward": toward,
             "next": nh[0] if nh else None, "next_name": nname, "car": car, "door": door, "cars": cars, "pos": pos}
        if len(prevs) > 1:
            e["prev_alt"] = prevs[1:]
        n_ok += 1
        if not prevs and not origin and pos != "middle":
            # 열차 방향을 모르면(종착역명이 비었거나 relation으로 못 찾음) 앞·뒤를 정할 수 없다. 가운데만 방향과 상관없이 맞다.
            why = "종착역명 없음" if not toward else "종착역 방향 못 찾음"
            dropped[f"{why}: {my_line} {sname} → {toward or '?'}"] += 1
            continue
        key = json.dumps(e, ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        n_prev += e["prev"] is not None
        n_prev_alt += "prev_alt" in e
        n_origin += origin
        if nname and e["next"] is None:
            rep.setdefault("next_unmapped", Counter())[f"{to_name} '{nname}'"] += 1
        if toward and not th:
            rep.setdefault("toward_unmapped", Counter())[f"{line} '{toward}'"] += 1
        out.append(e)
    rep["fast_entries"] = len(out)
    rep["fast_rows_mapped"] = n_ok
    rep["fast_unmapped"] = dict(unmapped.most_common())
    rep["fast_dropped_no_direction"] = dict(dropped.most_common())
    rep["prev_resolved"] = n_prev
    rep["prev_alt"] = n_prev_alt
    rep["prev_null_origin"] = n_origin
    rep["fast_stations"] = len({e["s"] for e in out})
    out.sort(key=lambda e: (e["s"], e["line"], e["to_line"], e["toward"], e["next_name"]))
    return out


def pick_names(names):
    """출구 하나의 이름 목록(자료 순서, 중복 제거)에서 EXIT_NAMES_MAX개를 고른다. 순서는 자료 순서 그대로."""
    by_key = {}
    for n in names:  # 띄어쓰기만 다른 이름(예: '동대문 우체국'·'동대문우체국')은 처음 것 하나만
        n = re.sub(r"\s+", " ", n).strip()
        if n:
            by_key.setdefault(n.replace(" ", ""), n)
    names = list(by_key.values())
    if len(names) <= EXIT_NAMES_MAX:
        return names

    def rank(n):
        return 0 if DONG_RE.match(n) else 1 if MAJOR_RE.search(n) else 2
    keep = set(sorted(range(len(names)), key=lambda i: (rank(names[i]), i))[:EXIT_NAMES_MAX])
    return [n for i, n in enumerate(names) if i in keep]


def build_exits(G, rep):
    rows = read_csv(EXIT_CSV)
    rep["exit_rows"] = len(rows)
    raw = defaultdict(lambda: defaultdict(list))
    unmapped = Counter()
    mapped = 0
    for r in rows:
        line_no, _ext, _code, sname, ref, area = [c.strip() for c in r[:6]]
        label = line_no + "호선" if line_no.isdigit() else None
        hits = G.find(sname, label) if label else []
        if not hits:
            unmapped[f"{label} '{sname}'"] += 1
            continue
        ref = ref.replace(" ", "")
        if not re.fullmatch(r"\d+(-\d+)?", ref):  # 출구 번호가 아닌 것(예: 반포 '00(연결통로)')
            unmapped[f"출구 번호 아님: {sname} '{ref}'"] += 1
            continue
        mapped += 1
        raw[hits[0]][ref].append(area)
    out = {}
    trimmed = 0
    for si in sorted(raw):
        def ref_key(x):
            m = re.match(r"(\d+)(?:-(\d+))?", x)
            return (int(m.group(1)), int(m.group(2) or 0), x) if m else (9999, 0, x)
        ex = {}
        for ref in sorted(raw[si], key=ref_key):
            names = pick_names(raw[si][ref])
            trimmed += len({re.sub(r"\s+", "", n) for n in raw[si][ref]} - {""}) > len(names)
            ex[ref] = names
        out[str(si)] = ex
    rep["exit_rows_mapped"] = mapped
    rep["exit_unmapped"] = dict(unmapped.most_common())
    rep["exit_stations"] = len(out)
    rep["exit_refs"] = sum(len(v) for v in out.values())
    rep["exit_refs_trimmed"] = trimmed
    # OSM 출입구 ref와 맞는 비율(같은 역의 출입구 ref 중 자료에 있는 것)
    ent = G.g["entrances"]
    osm_refs = defaultdict(set)
    for st, ref in zip(ent["station"], ent["ref"]):
        osm_refs[st].add(ref)
    have = sum(1 for si, ex in out.items() for ref in osm_refs.get(int(si), ()) if ref in ex)
    total = sum(len(osm_refs.get(int(si), ())) for si in out)
    rep["exit_osm_refs_matched"] = f"{have}/{total}"
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    with open(GRAPH, encoding="utf-8") as f:
        G = Graph(json.load(f))
    rep = {}
    fast = build_fast(G, rep)
    exits = build_exits(G, rep)
    data = {"format": "extra-1", "sources": SOURCES, "fast": fast, "exits": exits}
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    size = len(text.encode("utf-8"))
    rep["bytes"] = size
    rep["bytes_gzip"] = len(gzip.compress(text.encode("utf-8"), 9))
    rep["bytes_fast"] = len(json.dumps(fast, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    rep["bytes_exits"] = len(json.dumps(exits, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    os.makedirs(os.path.dirname(OUT_REPORT), exist_ok=True)
    with open(OUT_REPORT, "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=1)
    print(f"빠른 환승: CSV {rep['fast_rows']}행 중 {rep['fast_rows_mapped']}행 맞춤 → 항목 {rep['fast_entries']}개(중복 제거),"
          f" 역 {rep['fast_stations']}곳")
    print(f"  prev 찾음 {rep['prev_resolved']}/{rep['fast_entries']}, prev 후보 여럿 {rep['prev_alt']},"
          f" prev 없음(그 역에서 출발하는 열차) {rep['prev_null_origin']}")
    print(f"  방향을 몰라 뺀 행 {sum(rep['fast_dropped_no_direction'].values())}:")
    for k, v in rep["fast_dropped_no_direction"].items():
        print(f"    {v} × {k}")
    print("  편성(량):", ", ".join(f"{l} {v['used']}(자료 {v['data_max']})" for l, v in rep["cars"].items()))
    print(f"  못 쓴 행 {sum(rep['fast_unmapped'].values())}:")
    for k, v in rep["fast_unmapped"].items():
        print(f"    {v} × {k}")
    for key in ("toward_unmapped", "next_unmapped"):
        if rep.get(key):
            print(f"  {key}:", ", ".join(f"{k}×{v}" for k, v in rep[key].items()))
    print(f"역세권: CSV {rep['exit_rows']}행 중 {rep['exit_rows_mapped']}행 맞춤, 역 {rep['exit_stations']}곳, 출구 {rep['exit_refs']}개"
          f"(이름 {EXIT_NAMES_MAX}개로 줄인 출구 {rep['exit_refs_trimmed']}), OSM 출구 ref 맞음 {rep['exit_osm_refs_matched']}")
    if rep["exit_unmapped"]:
        print("  못 맞춘 역:", ", ".join(f"{k}×{v}" for k, v in rep["exit_unmapped"].items()))
    print(f"크기: {size:,} byte (gzip {rep['bytes_gzip']:,}; fast {rep['bytes_fast']:,}, exits {rep['bytes_exits']:,})"
          f" → {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
