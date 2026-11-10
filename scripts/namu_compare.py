# namu_compare.py
# 하는 일: 나무위키에서 모은 '지상/지하 구간' 목록(namu_aboveground.json)을 OSM 선로 구조(tunnel/bridge 태그)와 대조한다.
#   항목마다
#   1) 노선 선로 = 본선 중 way name 이 LINE_KEYS 의 이름과 같은 것 + 이름에 키워드가 들어간 노선 relation 의 멤버.
#   2) 두 역을 이름으로 찾아(괄호·'역'·공백 무시) 노선 선로 노드에 붙인다(800m 이내, 상·하행 선로 각각).
#   3) 두 역 사이 최단 선로 경로를 찾는다(다익스트라). 노선 선로가 아닌 선로(다른 노선·측선)는 비용을 5배로 친다.
#      역이 하나뿐인 항목(from = to)은 그 역 반경 NEAR_M 안의 노선 선로를 본다.
#   4) 경로 길이를 구조별(터널 / 교량 / 지상)로 더한다. data-check.md 규칙대로 layer<0 만 있는 선로는 '지상'이다.
#   5) 판정 기준은 아래 judge() 주석에 있다. 한강을 건너는 항목은 강 위 선로의 구조도 따로 본다.
# 사용법: python -I scripts\namu_compare.py <ways_kr.json> <stations.json> <routes.json> <han_river.json> <namu_aboveground.json> <출력.json>
import heapq
import json
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I 로 실행해도 옆 스크립트를 불러오기 위해
from han_crossings import seg_cross  # noqa: E402  선분 교차
from merge_ways import haversine_km  # noqa: E402

ABOVE = {"elevated", "bridge", "at_grade", "unknown"}  # 나무위키가 '지상'이라고 한 유형
SNAP_M = 800      # 역 노드 -> 선로 노드 최대 거리
NEAR_M = 150      # 역 하나 항목의 반경 m (300m로 하면 종착역의 지하 진입부가 많이 들어감)
OFFLINE_COST = 5  # 노선 선로가 아닌 선로(다른 노선·측선)를 지날 때 비용 배수

# 나무위키 노선 이름 -> (way name 정확히 일치 목록, relation 이름에 들어갈 키워드 목록)
LINE_KEYS = {
    "서울 지하철 1호선": (["서울 지하철 1호선"], ["수도권 전철 1호선"]),
    "수도권 전철 1호선": (["경부선", "서울 지하철 1호선"], ["수도권 전철 1호선"]),
    "서울 지하철 2호선": (["2호선"], ["서울 지하철 2호선:"]),
    "서울 지하철 2호선 성수지선": (["성수지선"], ["성수지선"]),
    "서울 지하철 3호선": (["3호선", "서울 지하철 3호선"], ["수도권 전철 3호선"]),
    "서울 지하철 4호선": (["4호선", "진접선"], ["수도권 전철 4호선"]),
    "서울 지하철 5호선": (["5호선", "하남선"], ["서울 지하철 5호선"]),
    "서울 지하철 6호선": (["6호선"], ["서울 지하철 6호선"]),
    "서울 지하철 7호선": (["7호선"], ["서울 지하철 7호선"]),
    "서울 지하철 8호선": (["8호선", "별내선"], ["서울 지하철 8호선"]),
    "서울 지하철 9호선": (["9호선"], ["서울 지하철 9호선"]),
    "수인분당선": (["분당선", "수인선", "안산선"], ["수인·분당선"]),
    "신분당선": (["신분당선"], ["신분당선"]),
    "공항철도": (["인천국제공항선"], ["인천국제공항철도"]),
    "수도권 전철 경의·중앙선": (["경의선", "중앙선", "용산선"], ["경의·중앙선"]),
    "수도권 전철 경춘선": (["경춘선"], ["수도권 전철 경춘선"]),
    "수도권 전철 서해선": (["서해선"], ["수도권 전철 서해선"]),
    "수도권 광역급행철도 A선(GTX-A)": (["수도권광역급행철도에이선"], ["수도권 광역급행철도 A선"]),
    "경강선": (["경강선"], ["수도권 전철 경강선", "강릉선 KTX"]),
    "우이신설선": (["우이신설선"], ["우이신설선"]),
    "신림선": (["신림선"], ["신림선"]),
    "김포 골드라인": (["김포 골드라인"], ["김포 골드라인"]),
    "인천 도시철도 1호선": (["인천 도시철도 1호선"], ["인천 도시철도 1호선"]),
    "인천 도시철도 2호선": (["인천 도시철도 2호선"], ["인천 도시철도 2호선"]),
    "의정부 경전철": (["의정부경전철"], ["의정부경전철"]),
    "용인 에버라인": (["용인경전철"], ["용인 경전철"]),
    "부산 도시철도 1호선": (["부산 도시철도 1호선"], ["부산 도시철도 1호선"]),
    "부산 도시철도 2호선": (["부산 도시철도 2호선"], ["부산 도시철도 2호선"]),
    "부산 도시철도 3호선": (["부산 도시철도 3호선"], ["부산 도시철도 3호선"]),
    "부산 도시철도 4호선": (["부산 도시철도 4호선"], ["부산 도시철도 4호선"]),
    "부산김해경전철": (["부산김해경전철"], ["부산김해경전철"]),
    "동해선 광역전철(부산 구간)": (["동해선"], ["동해선 광역전철"]),
    "대구 도시철도 1호선": (["대구 도시철도 1호선", "안심~하양 복선전철"], ["대구 도시철도 1호선"]),
    "대구 도시철도 2호선": (["대구 도시철도 2호선", "대구 2호선"], ["대구 도시철도 2호선"]),
    "대구 도시철도 3호선": (["대구 도시철도 3호선"], ["대구 도시철도 3호선"]),
    "대전 도시철도 1호선": (["대전 도시철도 1호선"], ["대전 도시철도 1호선"]),
    "광주 도시철도 1호선": (["광주 도시철도 1호선", "광주도시철도 1호선", "광주 1호선"], ["광주 도시철도 1호선"]),
    "(참고) 한국 철도 터널 순위": (["수서평택고속선", "수도권광역급행철도에이선"], []),
}

# 항목별 예외 처리. 키 = (line, from_station, to_station). 이유를 함께 적는다.
SPECIAL = {
    # '제외 전 구간' 항목: 두 역 사이 경로 대신 노선 전체 선로(선로 km)에서 제외 구간을 빼고 본다.
    #   way name(경부선·중앙선 등)은 전국 노선이라 쓰지 않고 노선 relation 멤버만 쓴다.
    ("수도권 전철 1호선", "(서울 지하철 1호선 구간 제외 전 구간)", ""):
        {"mode": "line", "exclude_path": ("서울역", "청량리"), "line_keys_of": "서울 지하철 1호선"},
    ("수도권 전철 경의·중앙선", "(홍대입구~효창공원앞 제외 전 구간)", ""):
        {"mode": "line", "exclude_path": ("홍대입구", "효창공원앞")},
    # OSM에 서울역~수서 선로가 없다(경로 없음). 운행 구간 두 개로 나눠 보고 합친다.
    ("수도권 광역급행철도 A선(GTX-A)", "운정중앙", "동탄"): {"legs": [("운정중앙", "서울역"), ("수서", "동탄")]},
    # 나무위키가 '구간 전체가 지상'이 아니라 '사이에 지상 부분이 있다'고만 쓴 항목
    ("서울 지하철 4호선", "동작", "이수"): {"claim": "contains", "why": "‘동작대교 이후 지상 구간 존재 시사’라고만 씀"},
    ("서울 지하철 8호선", "복정", "산성"): {"claim": "contains", "focus": "남위례", "why": "‘남위례역이 유일한 지상역’이라고 씀"},
    ("수도권 전철 서해선", "신현", "시흥시청"): {"claim": "contains", "why": "‘두 역 모두 지하역이나 사이에 지상구간 있음’"},
    ("인천 도시철도 2호선", "인천대공원", "운연"): {"claim": "contains", "why": "‘인천대공원~운연 사이 잠시 지하구간’"},
    # 아래 두 항목은 1차 실행 뒤 다른 출처를 보고 분류를 바꿨다(엄격 판정으로는 둘 다 mismatch).
    ("공항철도", "인천공항1터미널", "인천공항2터미널"):
        {"claim": "contains", "why": "인포박스 '지상구간'은 두 역 사이 일부를 뜻함. 위키백과 인천공항2터미널역: "
                                     "'이 역과 인천공항1터미널역 사이에는 일부 지상 구간이 존재한다'"},
    ("부산 도시철도 1호선", "노포", "노포"):
        {"treat_as": "semi_underground", "why": "나무위키 '승강장 위가 덮여 반지하처럼 보임', 위키백과 노포역 '반지하역'"},
    # 나무위키에 구조 서술이 없는 항목
    ("경강선", "판교", "여주"): {"claim": "none", "why": "‘판교~여주 구간 지상/지하 구분 없음’"},
    # 나무위키가 터널·교량 길이 합계를 준 항목
    ("경강선", "서원주", "강릉"): {"expect_km": {"tunnel": 76.0, "bridge": 14.2}},
}


def norm_variants(name):
    """역 이름 -> 비교용 이름들. 괄호 밖 이름과 괄호 안 이름('구 당고개' -> '당고개')을 모두 만든다."""
    out = set()
    for part in [re.sub(r"\(.*?\)", "", name)] + re.findall(r"\((.*?)\)", name):
        s = re.sub(r"^구\s*", "", part.strip())
        s = re.sub(r"[\s·ㆍ.]", "", s)
        if s.endswith("역") and len(s) > 2:
            s = s[:-1]
        if s:
            out.add(s)
    return out


def station_index(stations):
    """비교용 이름 -> [(lat, lon, OSM id, 원래 이름)]"""
    idx = defaultdict(list)
    for e in stations:
        t = e.get("tags", {})
        c = (e["lat"], e["lon"]) if "lat" in e else (e["center"]["lat"], e["center"]["lon"])
        names = set()
        for k in ("name", "name:ko", "alt_name", "alt_name:ko", "old_name", "old_name:ko", "official_name"):
            for v in t.get(k, "").split(";"):
                if v:
                    names |= norm_variants(v)
        for n in names:
            idx[n].append((c[0], c[1], f'{e["type"]}/{e["id"]}', t.get("name", "")))
    return idx


def m_between(a, b):
    return haversine_km(a[0], a[1], b[0], b[1]) * 1000


def group(cls):
    """way 구조 -> 판정용 3분류. layer<0(underground_notag)은 지상으로 친다."""
    return {"tunnel": "tunnel", "bridge": "bridge"}.get(cls, "ground")


class Rail:
    """본선 선로 그래프: 노드 좌표, 인접 목록, way 정보."""

    def __init__(self, ways, routes):
        self.way = {w["id"]: w for w in ways}
        self.coord, self.adj = {}, defaultdict(list)
        for w in ways:
            for n, p in zip(w["nodes"], w["geom"]):
                self.coord[n] = tuple(p)
            for a, b in zip(w["nodes"], w["nodes"][1:]):
                km = haversine_km(*self.coord[a], *self.coord[b])
                self.adj[a].append((b, km, w["id"]))
                self.adj[b].append((a, km, w["id"]))
        self.rel_names = defaultdict(set)
        for r in routes:
            for m in r["members"]:
                if m["type"] == "way":
                    self.rel_names[m["ref"]].add(r.get("tags", {}).get("name", ""))

    def line_ways(self, line, rel_only=False):
        """노선 선로 way ID 집합. 본선은 이름 또는 relation 으로, 측선은 relation 멤버일 때만 넣는다."""
        names, rel_keys = LINE_KEYS[line]
        return {wid for wid, w in self.way.items()
                if (not rel_only and not w["service_side"] and w["tags"].get("name", "") in names)
                or any(k in rn for rn in self.rel_names[wid] for k in rel_keys)}

    def snap(self, cands, line_set):
        """역 후보 좌표마다 노선 선로 노드를 찾는다 -> [(node, 거리m, 역 정보)].
        상·하행 선로가 따로 그려져 있고 건넘선(측선)은 그래프에서 뺐으므로, 가장 가까운 선로 하나가 아니라
        '가장 가까운 거리 + 150m' 안에 있는 선로마다 가장 가까운 노드를 하나씩 돌려준다."""
        out = []
        for c in cands:
            per_way = []
            for wid in line_set:
                n = min(self.way[wid]["nodes"], key=lambda n: (self.coord[n][0] - c[0]) ** 2 + ((self.coord[n][1] - c[1]) * 0.8) ** 2)
                per_way.append((n, m_between(self.coord[n], c), c))
            dmin = min(s[1] for s in per_way)
            out += [s for s in per_way if s[1] <= dmin + 150]
        return out

    def path(self, sources, targets, line_set):
        """여러 출발 노드 -> 여러 도착 노드 최단 경로. [(노드a, 노드b, km, way id)] 를 돌려준다."""
        dist, prev, pq = {}, {}, []
        for s in sources:
            dist[s] = 0.0
            heapq.heappush(pq, (0.0, s))
        targets = set(targets)
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist.get(u, 1e18):
                continue
            if u in targets:
                edges = []
                while u in prev:
                    p, km, wid = prev[u]
                    edges.append((p, u, km, wid))
                    u = p
                return edges[::-1]
            if d > 400:  # 400km 넘게 돌면 포기
                break
            for v, km, wid in self.adj[u]:
                nd = d + km * (1 if wid in line_set else OFFLINE_COST)
                if nd < dist.get(v, 1e18):
                    dist[v], prev[v] = nd, (u, km, wid)
                    heapq.heappush(pq, (nd, v))
        return None


def summarize(edges, rail, line_set):
    """경로(또는 선로 조각) -> 구조별 km, 구조가 이어지는 조각 목록."""
    km = defaultdict(float)
    pieces = []
    for a, b, k, wid in edges:
        g = group(rail.way[wid]["cls"])
        km[g] += k
        if rail.way[wid]["cls"] == "underground_notag":
            km["layer<0"] += k
        if wid not in line_set:
            km["offline"] += k
        if pieces and pieces[-1]["structure"] == g:
            pieces[-1]["km"] += k
            if wid not in pieces[-1]["ways"]:
                pieces[-1]["ways"].append(wid)
        else:
            pieces.append({"structure": g, "km": k, "ways": [wid], "start": rail.coord[a]})
    total = km["tunnel"] + km["bridge"] + km["ground"]
    for p in pieces:
        p["km"] = round(p["km"], 3)
    return total, km, pieces


def han_crossing(edges, rail, river_segs):
    """한강 중심선을 건너는 선로 조각의 구조 목록."""
    hits = []
    for a, b, k, wid in edges:
        pa, pb = rail.coord[a], rail.coord[b]
        if max(pa[0], pb[0]) < 37.4 or min(pa[0], pb[0]) > 37.7:
            continue
        for q1, q2 in river_segs:
            if seg_cross(pa, pb, q1, q2):
                hits.append({"way": wid, "structure": group(rail.way[wid]["cls"])})
    return hits


def judge(e, sp, share_nt, km, total, pieces, han):
    """판정 -> (verdict, basis). share_nt = 비터널 비율(0~1)."""
    t = sp.get("treat_as", e["type"])
    if sp.get("claim") == "none":
        return "ambiguous", "나무위키에 구조 서술 없음: " + sp["why"]
    if "expect_km" in sp:  # 나무위키 터널 km 와 ±15% 이내면 일치
        ex = sp["expect_km"]["tunnel"]
        ok = abs(km["tunnel"] - ex) <= 0.15 * ex
        return ("match" if ok else "mismatch"), f'터널 OSM {km["tunnel"]:.1f}km vs 나무위키 {ex}km (±15% 기준)'
    if sp.get("claim") == "contains":  # '사이에 지상 부분이 있다' -> 비터널 0.2km 이상이면 일치
        nt = km["bridge"] + km["ground"]
        return ("match" if nt >= 0.2 else "mismatch"), f"구간 안 비터널 {nt:.2f}km (0.2km 이상이면 일치). {sp['why']}"
    if t in ABOVE:  # 비터널 50% 이상이면 일치. 교량 항목은 한강 위 구조나 교량 길이로도 인정
        if share_nt >= 0.5:
            extra = " (단, OSM에는 평면 선로가 없고 교량뿐)" if t == "at_grade" and km["ground"] < 0.1 else ""
            return "match", f"비터널 {share_nt:.0%} ≥ 50%" + extra
        if t == "bridge" and han and all(h["structure"] == "bridge" for h in han):
            return "match", f"비터널 {share_nt:.0%} < 50%지만 한강 위 선로가 모두 교량(역~강변 지하 진입부 포함 때문)"
        if t == "bridge" and e.get("length_km") and km["bridge"] >= 0.8 * e["length_km"]:
            return "match", f'비터널 {share_nt:.0%} < 50%지만 교량 {km["bridge"]:.2f}km ≥ 나무위키 길이의 80%'
        return "mismatch", f"비터널 {share_nt:.0%} < 50%"
    if t == "semi_underground":  # 반지하는 OSM이 어느 쪽으로 그려도 될 수 있다
        why = f" ({sp['why']})" if sp.get("treat_as") else ""
        if share_nt >= 0.5:
            return "match", f"비터널 {share_nt:.0%} ≥ 50%" + why
        return "ambiguous", f"반지하 구간을 OSM은 터널로 표시(터널 {1 - share_nt:.0%})" + why
    if t == "fully_underground":
        ok = share_nt <= 0.05
        return ("match" if ok else "mismatch"), f"터널 {1 - share_nt:.1%} ({'≥' if ok else '<'} 95%)"
    if t == "river_tunnel":
        if han:
            ok = all(h["structure"] == "tunnel" for h in han)
            return ("match" if ok else "mismatch"), "한강 위 선로 구조: " + ",".join(sorted({h["structure"] for h in han}))
        return ("match" if share_nt <= 0.05 else "mismatch"), f"한강 교차 못 찾음, 구간 터널 {1 - share_nt:.0%}"
    if t == "tunnel":
        ok = share_nt <= 0.05
        return ("match" if ok else "mismatch"), f'터널 {1 - share_nt:.1%}, 터널 {km["tunnel"]:.1f}km vs 나무위키 {e.get("length_km")}km'
    return "ambiguous", "알 수 없는 유형"


def main():
    ways_f, st_f, routes_f, river_f, namu_f, out_f = sys.argv[1:7]
    with open(ways_f, encoding="utf-8") as f:
        ways = json.load(f)  # 측선도 그래프에 넣는다(역 구내에서 본선끼리 측선으로만 이어진 곳이 있음). 비용은 노선 밖과 같게 5배
    with open(st_f, encoding="utf-8") as f:
        st_idx = station_index(json.load(f)["elements"])
    with open(routes_f, encoding="utf-8") as f:
        routes = [e for e in json.load(f)["elements"] if e["type"] == "relation"]
    with open(river_f, encoding="utf-8") as f:
        river = [[(p["lat"], p["lon"]) for p in e["geometry"]] for e in json.load(f)["elements"] if e["type"] == "way"]
    river_segs = [(a, b) for line in river for a, b in zip(line, line[1:])]
    with open(namu_f, encoding="utf-8") as f:
        entries = json.load(f)
    rail = Rail(ways, routes)

    def find_station(name, line_set):
        cands = [c for v in norm_variants(name) for c in st_idx.get(v, [])]
        if not cands:
            return None, f"OSM 역 이름 '{name}' 없음"
        snapped = [s for s in rail.snap(cands, line_set) if s[1] <= SNAP_M]
        if not snapped:
            near = min(rail.snap(cands, line_set), key=lambda s: s[1])
            return None, f"역 '{name}'이 노선 선로에서 {near[1]:.0f}m 떨어짐(기준 {SNAP_M}m)"
        return snapped, ""

    def stretch(a, b, line_set):
        sa, why_a = find_station(a, line_set)
        sb, why_b = find_station(b, line_set)
        if not sa or not sb:
            return None, None, (why_a + " " + why_b).strip()
        edges = rail.path([s[0] for s in sa], [s[0] for s in sb], line_set)
        if edges is None:
            return None, None, "두 역 사이 선로 경로 없음"
        info = {"osm_from": sorted({s[2][2] for s in sa}), "osm_to": sorted({s[2][2] for s in sb}),
                "snap_m": round(max(min(s[1] for s in sa), min(s[1] for s in sb)))}
        return edges, info, ""

    def near_edges(name, line_set):
        sa, why = find_station(name, line_set)
        if not sa:
            return None, None, why
        node, d, c = min(sa, key=lambda s: s[1])
        p0 = rail.coord[node]
        edges = []
        for wid in line_set:
            w = rail.way[wid]
            for a, b in zip(w["nodes"], w["nodes"][1:]):
                pa, pb = rail.coord[a], rail.coord[b]
                if m_between(((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2), p0) <= NEAR_M:
                    edges.append((a, b, haversine_km(*pa, *pb), wid))
        return edges, {"osm_station": c[2], "snap_m": round(d), "radius_m": NEAR_M}, ""

    results = []
    for i, e in enumerate(entries):
        key = (e["line"], e["from_station"], e["to_station"])
        sp = SPECIAL.get(key, {})
        res = {"idx": i, "line": e["line"], "city": e["city"], "from": e["from_station"], "to": e["to_station"],
               "namu_type": e["type"], "namu_length_km": e["length_km"], "source_url": e["source_url"]}
        if e["line"] not in LINE_KEYS:
            results.append({**res, "verdict": "not_found", "reason": "LINE_KEYS 에 노선 없음"})
            continue
        line_set = rail.line_ways(e["line"], rel_only=sp.get("mode") == "line")
        note = ""
        if sp.get("legs"):  # 구간 여러 개를 이어 붙인다
            edges, info, why = [], {"method": "두 역 사이 최단 선로 경로(구간별)", "legs": []}, ""
            for a, b in sp["legs"]:
                le, linfo, lwhy = stretch(a, b, line_set)
                if not le:
                    edges, why = None, f"{a}–{b}: {lwhy}"
                    break
                edges += le
                info["legs"].append({"from": a, "to": b, "km": round(sum(x[2] for x in le), 3), **linfo})
        elif sp.get("mode") == "line":  # 노선 전체 - 제외 구간
            ex_edges, _, why = stretch(*sp["exclude_path"], rail.line_ways(sp.get("line_keys_of", e["line"])))
            ex_ways = {wid for *_, wid in ex_edges} if ex_edges else set()
            # 제외 구간과 나란한 반대 방향 선로도 빼기 위해, 제외 구간 노드에서 60m 안에 대부분 있는 way 도 뺀다
            ex_pts = [rail.coord[a] for a, *_ in ex_edges or []]
            box = (min(p[0] for p in ex_pts) - 0.002, max(p[0] for p in ex_pts) + 0.002,
                   min(p[1] for p in ex_pts) - 0.002, max(p[1] for p in ex_pts) + 0.002) if ex_pts else None
            for wid in line_set:
                g = rail.way[wid]["geom"]
                if not box or not any(box[0] <= p[0] <= box[1] and box[2] <= p[1] <= box[3] for p in g):
                    continue
                close = sum(1 for p in g if any(m_between(p, q) < 60 for q in ex_pts))
                if close >= 0.5 * len(g):
                    ex_ways.add(wid)
            edges = [(a, b, haversine_km(*rail.coord[a], *rail.coord[b]), wid)
                     for wid in line_set - ex_ways for a, b in zip(rail.way[wid]["nodes"], rail.way[wid]["nodes"][1:])]
            info = {"method": "노선 전체 선로 km(복선은 두 번 셈)에서 제외 구간을 뺌", "excluded_ways": sorted(ex_ways)}
            note = why
        elif e["from_station"] == e["to_station"]:
            edges, info, why = near_edges(e["from_station"], line_set)
            if info:
                info["method"] = f"역 반경 {NEAR_M}m"
        else:
            edges, info, why = stretch(e["from_station"], e["to_station"], line_set)
            if info:
                info["method"] = "두 역 사이 최단 선로 경로"
        if not edges:
            results.append({**res, "verdict": "not_found", "reason": why})
            print(f"[not_found] {i} {e['line']} {e['from_station']}–{e['to_station']}: {why}")
            continue
        total, km, pieces = summarize(edges, rail, line_set)
        han = han_crossing(edges, rail, river_segs)
        share_nt = (km["bridge"] + km["ground"]) / total if total else 0
        verdict, basis = judge(e, sp, share_nt, km, total, pieces, han)
        res.update({
            **info, "osm_km": round(total, 3), "tunnel_km": round(km["tunnel"], 3), "bridge_km": round(km["bridge"], 3),
            "ground_km": round(km["ground"], 3), "layer_neg_km": round(km["layer<0"], 3),
            "offline_km": round(km["offline"], 3), "nontunnel_share": round(share_nt, 3),
            "han_crossing": han, "verdict": verdict, "basis": basis, "note": note,
            "way_ids": sorted({wid for *_, wid in edges})[:80],
        })
        # 판정과 어긋나는 쪽 조각(지상 항목이면 터널 조각, 지하 항목이면 비터널 조각)의 way ID
        bad = "tunnel" if e["type"] in ABOVE or e["type"] == "semi_underground" else "non-tunnel"
        if sp.get("mode") != "line":
            res["contrary_pieces"] = [p for p in pieces if (p["structure"] == "tunnel") == (bad == "tunnel")]
        if sp.get("focus"):  # 나무위키가 지목한 역 주변도 따로 본다
            fe, finfo, fwhy = near_edges(sp["focus"], line_set)
            if fe:
                ft, fkm, _ = summarize(fe, rail, line_set)
                res["focus"] = {**finfo, "name": sp["focus"], "osm_km": round(ft, 3),
                                "tunnel_km": round(fkm["tunnel"], 3), "bridge_km": round(fkm["bridge"], 3),
                                "ground_km": round(fkm["ground"], 3), "way_ids": sorted({wid for *_, wid in fe})}
            else:
                res["focus"] = {"name": sp["focus"], "reason": fwhy}
        results.append(res)
        print(f"[{verdict}] {i} {e['line']} {e['from_station']}–{e['to_station']} ({e['type']}) | "
              f"OSM {total:.2f}km 터널 {km['tunnel']:.2f} 교량 {km['bridge']:.2f} 지상 {km['ground']:.2f} "
              f"(off {km['offline']:.2f}) | {basis}")
    with open(out_f, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    counts = defaultdict(int)
    for r in results:
        counts[r["verdict"]] += 1
    print("판정 집계:", dict(counts))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
