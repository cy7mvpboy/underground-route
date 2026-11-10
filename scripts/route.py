# route.py
# 하는 일: web\data\graph.json을 읽어 두 역 사이에서 '지상 노출이 가장 적은' 도보 경로를 찾는다(참조 구현).
#   - 비용 = 길이 × 가중치. 터널·출입구·지하 환승은 1, 교량·지상은 1000(지상 1m = 지하 1km).
#   - 다익스트라 알고리즘. 나중에 JavaScript로 그대로 옮길 수 있게 단순하게 썼다.
#   - 막힌 간선(간선 번호 목록)은 없는 것으로 보고 탐색한다.
# 사용법(프로젝트 폴더에서):
#   python -I scripts\route.py <출발역> <도착역> [--block 12,34] [--block-han 5호선] [--json]
#   같은 이름 역이 여러 곳이면 '이름@지역'으로 고른다. 예) 시청@부산, 반월당@대구
#   --block-han 5호선 : 한강을 건너는 간선 중 노선 이름에 '5호선'이 든 것을 막는다.
import heapq
import json
import re
import sys

GRAPH = "web/data/graph.json"


def normalize_name(s):
    """build_graph.py와 같은 규칙: 괄호 내용·공백·끝의 '역'을 뺀다."""
    s = re.sub(r"\(.*?\)", "", s or "").replace(" ", "")
    if len(s) > 2 and s.endswith("역"):
        s = s[:-1]
    return s


def load_graph(path=GRAPH):
    """그래프를 읽고, 노드마다 (간선 번호, 반대쪽 노드) 목록을 만든다."""
    with open(path, encoding="utf-8") as f:
        g = json.load(f)
    E, T = g["edges"], g["tables"]
    under = {T["structs"].index(s) for s in T["under_structs"]}
    g["weight"] = [g["weights"]["under"] if s in under else g["weights"]["exposed"] for s in E["s"]]
    g["adj"] = [[] for _ in g["nodes"]["f"]]
    for i, (a, b) in enumerate(zip(E["a"], E["b"])):
        g["adj"][a].append((i, b))
        g["adj"][b].append((i, a))
    g["node_station"], g["hub_lines"] = {}, {}
    for si, s in enumerate(g["stations"]):
        for v in s["hubs"] + s["plat"]:
            g["node_station"][v] = si
        for v, ls in zip(s["hubs"], s["hub_ls"]):
            g["hub_lines"][v] = [T["lines"][i] for i in T["line_sets"][ls]]
    return g


def find_station(g, query):
    """'이름' 또는 '이름@지역'으로 역 번호를 찾는다."""
    name, _, region = query.partition("@")
    key = normalize_name(name)
    hits = [i for i, s in enumerate(g["stations"]) if key in s["names"]]
    if region:
        hits = [i for i in hits if region in g["tables"]["regions"][g["stations"][i]["rg"]]["name"]]
    if not hits:
        raise SystemExit(f"역을 찾지 못함: {query}")
    if len(hits) > 1:
        where = ", ".join(f"{g['stations'][i]['name']}@{g['tables']['regions'][g['stations'][i]['rg']]['name']}" for i in hits)
        print(f"  (참고) '{query}' 후보 {len(hits)}곳: {where} → 첫 번째를 씀")
    return hits[0]


def dijkstra(g, sources, targets, blocked=()):
    """sources(노드 목록)에서 targets 중 가장 싼 곳까지. 돌려주는 값: (도착 노드, 직전 간선 사전) 또는 (None, …)."""
    blocked, targets = set(blocked), set(targets)
    E = g["edges"]
    cost = {v: 0.0 for v in sources}
    prev = {}  # 노드 → (간선 번호, 이전 노드)
    heap = [(0.0, v) for v in sources]
    heapq.heapify(heap)
    done = set()
    while heap:
        c, v = heapq.heappop(heap)
        if v in done:
            continue
        done.add(v)
        if v in targets:
            return v, prev
        for ei, w in g["adj"][v]:
            if ei in blocked:
                continue
            nc = c + E["len"][ei] * g["weight"][ei]
            if nc < cost.get(w, float("inf")):
                cost[w] = nc
                prev[w] = (ei, v)
                heapq.heappush(heap, (nc, w))
    return None, prev


def edge_lines(g, ei):
    T = g["tables"]
    return [T["lines"][i] for i in T["line_sets"][g["edges"]["ls"][ei]]]


def describe(g, start_si, end_node, prev):
    """찾은 경로를 거리·지상 노출·노선·체크포인트(역, 환승, 터널 출입구, 출입구)로 정리한다."""
    E, T, F = g["edges"], g["tables"], g["nodes"]["f"]
    steps = []  # (간선, 출발 노드, 도착 노드)
    v = end_node
    while v in prev:
        ei, u = prev[v]
        steps.append((ei, u, v))
        v = u
    steps.reverse()
    total = exposed = 0.0
    lines_used, cur_line = [], None
    checkpoints = [{"type": "출발", "name": g["stations"][start_si]["name"], "at_m": 0, "leg_m": 0}]
    last_cp = 0.0
    for idx, (ei, u, v) in enumerate(steps):
        struct, kind = T["structs"][E["s"][ei]], T["kinds"][E["k"][ei]]
        total += E["len"][ei]
        if g["weight"][ei] != g["weights"]["under"]:
            exposed += E["len"][ei]
        if kind == "track":
            ls = edge_lines(g, ei)
            if ls and cur_line not in ls:  # 이름 없는 짧은 선로는 앞 노선을 이어 간다
                cur_line = ls[0]
                if not lines_used or lines_used[-1] != cur_line:
                    lines_used.append(cur_line)
        cp = None
        if kind == "transfer":  # 허브 → 허브
            cp = {"type": "환승", "name": g["stations"][g["node_station"][v]]["name"],
                  "from": g["hub_lines"].get(u, []), "to": g["hub_lines"].get(v, []),
                  "src": T["sources"][E["src"][ei]], "len_m": round(E["len"][ei]), "underground": struct == "underground"}
        elif kind == "track" and F[v] & 1 and idx + 1 < len(steps):  # 터널 출입구(갱구)
            nxt = T["structs"][E["s"][steps[idx + 1][0]]]
            if (struct == "tunnel") != (nxt == "tunnel"):
                cp = {"type": "터널 출입구", "name": "지상으로 나감" if struct == "tunnel" else "지하로 들어감"}
        elif kind == "entrance" and F[v] & 4:
            cp = {"type": "출입구", "name": ""}
        elif kind == "track" and F[v] & 2:  # 선로를 따라 역에 도착
            name = g["stations"][g["node_station"][v]]["name"]
            if checkpoints[-1]["name"] != name:
                cp = {"type": "역", "name": name}
        if cp:
            cp["at_m"], cp["leg_m"] = round(total), round(total - last_cp)
            last_cp = total
            checkpoints.append(cp)
    end_name = g["stations"][g["node_station"][end_node]]["name"]
    if checkpoints[-1]["type"] == "역" and checkpoints[-1]["name"] == end_name:
        checkpoints[-1]["type"] = "도착"
    else:
        checkpoints.append({"type": "도착", "name": end_name, "at_m": round(total), "leg_m": round(total - last_cp)})
    return {"edges": [s[0] for s in steps], "total_m": round(total), "exposed_m": round(exposed),
            "lines": lines_used, "checkpoints": checkpoints}


def han_edges(g, line_text):
    """한강 횡단 간선 중 노선 이름에 line_text가 든 것."""
    return [h["e"] for h in g["presets"]["han_crossings"] if any(line_text in l for l in h["lines"])]


def route(g, start, end, blocked=()):
    s, t = find_station(g, start), find_station(g, end)
    end_node, prev = dijkstra(g, g["stations"][s]["hubs"], g["stations"][t]["hubs"], blocked)
    if end_node is None:
        return None
    return describe(g, s, end_node, prev)


def print_result(start, end, r):
    if r is None:
        print(f"{start} → {end}: 경로 없음")
        return
    print(f"{start} → {end}: 총 {r['total_m'] / 1000:.2f}km, 지상 노출 {r['exposed_m'] / 1000:.2f}km, "
          f"간선 {len(r['edges'])}개")
    print("  노선: " + " → ".join(r["lines"]))
    for cp in r["checkpoints"]:
        extra = ""
        if cp["type"] == "환승":
            extra = (f" {'/'.join(cp['from']) or '?'} → {'/'.join(cp['to']) or '?'}"
                     f" ({cp['len_m']}m, {cp['src']}, {'지하' if cp['underground'] else '지상'})")
        print(f"  {cp['at_m'] / 1000:7.2f}km  +{cp.get('leg_m', 0):5d}m  {cp['type']} {cp['name']}{extra}")


def main():
    args = sys.argv[1:]
    blocked, as_json, pos = [], False, []
    i = 0
    while i < len(args):
        if args[i] == "--block":
            blocked += [int(x) for x in args[i + 1].split(",") if x]
            i += 2
        elif args[i] == "--block-han":
            pos.append(("han", args[i + 1]))
            i += 2
        elif args[i] == "--json":
            as_json = True
            i += 1
        else:
            pos.append(("name", args[i]))
            i += 1
    g = load_graph()
    for kind, val in pos:
        if kind == "han":
            blocked += han_edges(g, val)
    names = [v for k, v in pos if k == "name"]
    if blocked:
        print(f"막은 간선: {blocked}")
    r = route(g, names[0], names[1], blocked)
    if as_json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
    else:
        print_result(names[0], names[1], r)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
