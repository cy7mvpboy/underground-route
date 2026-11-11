# route.py
# 하는 일: web\data\graph.json을 읽어 두 역 사이에서 '지상 노출이 가장 적은' 도보 경로를 찾고, 길 안내 단계를 만든다(참조 구현).
#   - 비용 = 길이 × 가중치. 터널·출입구·지하 환승은 1, 교량·지상은 1000(지상 1m = 지하 1km).
#   - 다익스트라 알고리즘. 나중에 JavaScript로 그대로 옮길 수 있게 단순하게 썼다.
#   - 막힌 간선(간선 번호 목록)은 없는 것으로 보고 탐색한다.
#   - 길 안내 단계(steps): 노선 단위 '타기' 단계, 노선을 바꾸는 '환승' 단계, 지상으로 나가는 곳의 '노출 경고'.
# 사용법(프로젝트 폴더에서):
#   python -I scripts\route.py <출발역> <도착역> [--block 12,34] [--block-han 5호선] [--speed 3.5] [--checkpoints] [--json]
#   같은 이름 역이 여러 곳이면 '이름@지역'으로 고른다. 예) 시청@부산, 반월당@대구
#   --block-han 5호선 : 한강을 건너는 간선 중 노선 이름에 '5호선'이 든 것을 막는다.
#   --speed 3.5       : 예상 시간 계산에 쓰는 걷는 속도(km/h). 선로 위를 어둠 속에서 걷는 것을 생각해 기본 3.5.
#   --checkpoints     : 단계 목록 대신 예전 체크포인트 목록을 출력한다(--json에는 둘 다 들어 있다).
import heapq
import json
import re
import sys

GRAPH = "web/data/graph.json"
WALK_KMH = 3.5


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
    g["node_station"], g["hub_lines"], g["hub_short"] = {}, {}, {}
    for si, s in enumerate(g["stations"]):
        for v in s["hubs"] + s["plat"]:
            g["node_station"][v] = si
        for v, ls in zip(s["hubs"], s["hub_ls"]):
            g["hub_lines"][v] = [T["lines"][i] for i in T["line_sets"][ls]]
            g["hub_short"][v] = [T["line_short"][i] for i in T["line_sets"][ls]]
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


def is_exposed(g, ei):
    """지상 노출 간선인가(교량·지상)."""
    return g["weight"][ei] != g["weights"]["under"]


def path_edges(prev, end_node):
    """직전 간선 사전을 거꾸로 따라가 경로를 [(간선, 출발 노드, 도착 노드), …]로 만든다."""
    path, v = [], end_node
    while v in prev:
        ei, u = prev[v]
        path.append((ei, u, v))
        v = u
    path.reverse()
    return path


def describe(g, start_si, end_node, prev, speed_kmh=WALK_KMH):
    """찾은 경로를 거리·지상 노출·노선·체크포인트(역, 환승, 터널 출입구, 출입구)·길 안내 단계로 정리한다."""
    E, T, F = g["edges"], g["tables"], g["nodes"]["f"]
    steps = path_edges(prev, end_node)
    total = exposed = 0.0
    lines_used, cur_line = [], None
    checkpoints = [{"type": "출발", "name": g["stations"][start_si]["name"], "at_m": 0, "leg_m": 0}]
    last_cp = 0.0
    for idx, (ei, u, v) in enumerate(steps):
        struct, kind = T["structs"][E["s"][ei]], T["kinds"][E["k"][ei]]
        total += E["len"][ei]
        if is_exposed(g, ei):
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
            "speed_kmh": speed_kmh, "est_minutes": round(total / (speed_kmh * 1000 / 60)),
            "lines": lines_used, "checkpoints": checkpoints, "steps": build_steps(g, start_si, steps, speed_kmh)}


# ---------- 길 안내 단계 ----------

def split_parts(g, path):
    """경로를 '타기' 부분(선로·승강장 간선이 이어진 곳)과 '환승' 부분(환승 간선 하나)으로 나눈다.
    돌려주는 값: [{"kind": "ride"|"transfer", "idx": [경로 안 간선 위치, …]}, …]"""
    E, T = g["edges"], g["tables"]
    parts = []
    for i, (ei, u, v) in enumerate(path):
        kind = "transfer" if T["kinds"][E["k"][ei]] == "transfer" else "ride"
        if kind == "transfer" or not parts or parts[-1]["kind"] != "ride":
            parts.append({"kind": kind, "idx": []})
        parts[-1]["idx"].append(i)
    return parts


OTHER = -1  # 도시철도·광역전철 노선이 없는 선로(경부선, 기지선 등)


def pick_lines(sets, lens):
    """간선마다 노선 묶음(sets)에서 노선 하나를 고른다.
    지금 노선이 다음 간선에도 있으면 그대로 타고, 없으면 그 자리에서 가장 길게(m) 이어지는 노선으로 바꾼다.
    빈 묶음(승강장 간선, 이름 없는 선로)은 앞 노선을 이어 가고, 맨 앞의 빈 묶음은 첫 노선에 붙인다."""
    out, cur = [], None
    for j in range(len(sets)):
        if sets[j] and cur not in sets[j]:
            best, best_run = None, -1.0
            for line in sets[j]:
                run, k = 0.0, j
                while k < len(sets) and (not sets[k] or line in sets[k]):
                    run += lens[k]
                    k += 1
                if run > best_run:
                    best, best_run = line, run
            cur = best
        out.append(cur)
    first = next((x for x in out if x is not None), None)
    return [first if x is None else x for x in out]


def assign_lines(g, path, idx):
    """타기 부분의 간선마다 노선 번호(tables.lines 위치)를 정한다.
    1) 도시철도·광역전철 노선(tables.line_metro = 1)만 보고 고른다. 그런 노선이 없는 선로는 OTHER.
    2) 앞뒤가 같은 노선인 OTHER 구간(relation이 빠진 틈, 기지선을 지나는 곳)은 그 노선으로 메운다.
    3) 남은 OTHER 구간은 선로 이름에서 온 노선(예: 경부고속선)으로 고른다."""
    E, T = g["edges"], g["tables"]
    sets = [T["line_sets"][E["ls"][path[i][0]]] for i in idx]
    lens = [E["len"][path[i][0]] for i in idx]
    metro = [[l for l in s if T["line_metro"][l]] or ([OTHER] if s else []) for s in sets]
    out = pick_lines(metro, lens)
    j = 0
    while j < len(out):
        if out[j] != OTHER:
            j += 1
            continue
        k = j
        while k < len(out) and out[k] == OTHER:
            k += 1
        before = out[j - 1] if j > 0 else None
        after = out[k] if k < len(out) else None
        out[j:k] = [before] * (k - j) if before is not None and before == after else pick_lines(sets[j:k], lens[j:k])
        j = k
    return out


def terminal_direction(g, line, seq):
    """종착역 방면(예: '오금 방면', 순환선은 '내선순환'). 승강장 표지판처럼 종착역으로 적는다.
    1) 노선 relation의 정차역 순서에서 '출발역 바로 다음이 다음 역'이고 그 뒤에 도착역이 있는 relation을 모두 찾는다.
    2) 그중 다른 relation이 앞으로 지날 역에서 끝나는 것(중간 종착, 예: 5호선 상일동행은 하남검단산행이 지나는 역에서 끝남)은 뺀다.
    3) 남은 방면이 하나면 그대로, 여럿이면(도착역 뒤에서 노선이 갈라짐) 종착역을 '·'로 잇는다(예: '하남검단산·마천 방면').
       셋 이상이면 정차역이 가장 많은(가장 긴) 두 방면만 남긴다(같으면 line_routes 순서). 잇는 순서는 line_routes 순서.
    4) 하나도 못 찾으면 이 단계의 도착역 방면(예: '천호 방면'). 다음 역은 지나고 나면 반대쪽처럼 읽힌다."""
    if len(seq) < 2:
        return None
    a, b, z = seq[0], seq[1], seq[-1]
    found = []  # (방면, 종착역, 다음 역부터 앞으로 지날 정차역, relation 정차역 수)
    for r in g.get("line_routes", []):
        if r["l"] != line:
            continue
        st = r["st"] + r["st"][1:] if r["loop"] else r["st"]  # 순환선은 한 바퀴 더 붙여 끝을 넘어가는 경로도 찾는다
        for i in range(len(st) - 1):
            if st[i] == a and st[i + 1] == b and z in st[i + 1:]:
                found.append((r["dir"], r["st"][-1], st[i + 1:], len(r["st"])))
                break
    dirs, stops = [], {}  # stops: 방면 → 그 방면 relation 중 가장 많은 정차역 수
    for d, end, _, n in found:
        if any(d2 != d and end in ahead2 for d2, _, ahead2, _ in found):
            continue  # 중간 종착: 다른 방면 열차가 이 종착역을 지나 더 간다
        if d not in dirs:
            dirs.append(d)
        stops[d] = max(stops.get(d, 0), n)
    if len(dirs) > 2:  # 셋 이상(1호선)이면 가장 긴 두 방면만. sorted는 같은 값의 순서를 지키므로 같으면 line_routes 순서
        keep = sorted(dirs, key=lambda d: -stops[d])[:2]
        dirs = [d for d in dirs if d in keep]
    if len(dirs) == 1:
        return dirs[0]
    if dirs:
        return "·".join(d.replace(" 방면", "") for d in dirs) + " 방면"
    return f"{g['stations'][z]['name']} 방면"


def ride_step(g, path, idx, line, from_si, m_per_min):
    """타기 단계 하나를 만든다. 돌려주는 값: (단계, 마지막으로 지난 역 번호)."""
    E, T, S = g["edges"], g["tables"], g["stations"]
    seq = [(from_si, 0.0)]          # 지난 역: (역 번호, 단계 출발부터 거리 m)
    parts, lead = [], 0.0           # 선 구간: 선 이름이 바뀔 때마다 새 구간
    dist = exposed = 0.0
    for i in idx:
        ei, u, v = path[i]
        length = E["len"][ei]
        dist += length
        if is_exposed(g, ei):
            exposed += length
        tn = T["track_names"][E["tn"][ei]]
        if tn and (not parts or parts[-1]["name"] != tn):
            parts.append({"name": tn, "from_station": S[seq[-1][0]]["name"], "to_station": "", "distance_m": 0.0})
        if parts:
            parts[-1]["distance_m"] += length
        else:
            lead += length          # 첫 선 이름 앞의 승강장·이름 없는 간선은 첫 구간에 넣는다
        si = g["node_station"].get(v)
        if si is not None and si != seq[-1][0]:
            seq.append((si, dist))
    if parts:
        parts[0]["distance_m"] += lead
    for n, p in enumerate(parts):
        p["to_station"] = parts[n + 1]["from_station"] if n + 1 < len(parts) else S[seq[-1][0]]["name"]
        p["distance_m"] = round(p["distance_m"])
    track_names = []
    for p in parts:
        if p["name"] not in track_names:
            track_names.append(p["name"])
    full = T["lines"][line] if line is not None else ""
    short = T["line_short"][line] if line is not None else ""
    shown = [n for n in track_names if n not in (full, short)]  # 노선 이름과 같은 선 이름은 다시 쓰지 않는다
    label = " · ".join(([short] if short else []) + (["·".join(shown)] if shown else [])) or "이름 없는 선로"
    step = {"type": "ride", "line": short, "line_full": full, "label": label, "track_names": track_names,
            "track_parts": parts, "from_station": S[from_si]["name"], "to_station": S[seq[-1][0]]["name"],
            "direction": f"{S[seq[1][0]]['name']} 방면" if len(seq) > 1 else "",
            "passing": [{"station": S[si]["name"], "at_m": round(d)} for si, d in seq[1:-1]],
            "distance_m": round(dist), "est_minutes": round(dist / m_per_min), "exposure_m": round(exposed)}
    term = terminal_direction(g, line, [si for si, _ in seq])
    if term:
        step["terminal_direction"] = term
    return step, seq[-1][0]


def transfer_step(g, path, i, m_per_min):
    """환승 단계 하나(환승 간선 = 허브 → 허브). from_line·to_line은 앞뒤 타기 단계가 있으면 build_steps에서 그 노선으로 바꾼다."""
    E, T = g["edges"], g["tables"]
    ei, u, v = path[i]
    return {"type": "transfer", "station": g["stations"][g["node_station"][v]]["name"],
            "from_line": "/".join(g["hub_short"].get(u, [])), "to_line": "/".join(g["hub_short"].get(v, [])),
            "distance_m": round(E["len"][ei]), "est_minutes": round(E["len"][ei] / m_per_min),
            "source": T["sources"][E["src"][ei]], "underground": not is_exposed(g, ei)}


def exposure_warnings(g, start_si, path, edge_step):
    """지상 노출 경고: 지하(터널·지하 통로)에서 교량·지상으로 나가는 곳마다 하나(출발부터 지상이면 출발역에서 하나).
    at = 그곳 직전에 지난 역(after_m = 그 역에서 지난 거리), exposure_m = 다시 지하로 들어갈 때까지(또는 도착까지)의 노출 거리."""
    E, T, F, N, S = g["edges"], g["tables"], g["nodes"]["f"], g["nodes"], g["stations"]
    out, cur = [], None
    last_si, since = start_si, 0.0
    for i, (ei, u, v) in enumerate(path):
        length = E["len"][ei]
        if is_exposed(g, ei):
            if cur is None:
                cur = {"type": "warning", "step": edge_step[i], "at": S[last_si]["name"], "after_m": round(since),
                       "portal": (F[u] & 1) == 1, "lat": N["lat"][u] / 1e5, "lon": N["lon"][u] / 1e5,
                       "exposure_m": 0.0, "structures": {}, "ends_underground": False}
                out.append(cur)
            cur["exposure_m"] += length
            struct = T["structs"][E["s"][ei]]
            cur["structures"][struct] = cur["structures"].get(struct, 0.0) + length
        elif cur is not None:
            cur["ends_underground"] = True
            cur = None
        si = g["node_station"].get(v)
        if si is not None:
            last_si, since = si, 0.0
        else:
            since += length
    for w in out:
        w["structure"] = max(w["structures"], key=lambda s: w["structures"][s])  # 가장 긴 구조
        w["structures"] = {s: round(m) for s, m in w["structures"].items()}
        w["exposure_m"] = round(w["exposure_m"])
    return out


def build_steps(g, start_si, path, speed_kmh=WALK_KMH):
    """경로를 길 안내 단계 목록으로 만든다.
    1) 환승 간선에서 나누고, 2) 타기 부분은 노선이 바뀌는 곳에서 다시 나누고,
    3) 지상 노출 경고를 그 노출이 시작되는 단계 바로 앞에 끼운다. 타기·환승 단계에는 1부터 번호(no)를 붙인다."""
    m_per_min = speed_kmh * 1000 / 60
    steps, edge_step = [], [0] * len(path)  # edge_step: 경로 안 간선 위치 → 단계 번호
    last_si = start_si
    for part in split_parts(g, path):
        if part["kind"] == "transfer":
            i = part["idx"][0]
            edge_step[i] = len(steps)
            steps.append(transfer_step(g, path, i, m_per_min))
            last_si = g["node_station"].get(path[i][2], last_si)
            continue
        lines = assign_lines(g, path, part["idx"])
        j = 0
        while j < len(lines):
            k = j
            while k < len(lines) and lines[k] == lines[j]:
                k += 1
            for i in part["idx"][j:k]:
                edge_step[i] = len(steps)
            step, last_si = ride_step(g, path, part["idx"][j:k], lines[j], last_si, m_per_min)
            steps.append(step)
            j = k
    for n, s in enumerate(steps):  # 환승 단계의 노선 이름은 앞뒤 타기 단계의 노선으로
        if s["type"] == "transfer":
            if n > 0 and steps[n - 1]["type"] == "ride" and steps[n - 1]["line"]:
                s["from_line"] = steps[n - 1]["line"]
            if n + 1 < len(steps) and steps[n + 1]["type"] == "ride" and steps[n + 1]["line"]:
                s["to_line"] = steps[n + 1]["line"]
    warnings = exposure_warnings(g, start_si, path, edge_step)
    out = []
    for n, s in enumerate(steps):
        s["no"] = n + 1
        for w in warnings:
            if w["step"] == n:
                w["in_step"] = n + 1
                out.append(w)
        out.append(s)
    for w in warnings:
        del w["step"]
    return out


# ---------- 실행 ----------

def han_edges(g, line_text):
    """한강 횡단 간선 중 노선 이름에 line_text가 든 것."""
    return [h["e"] for h in g["presets"]["han_crossings"] if any(line_text in l for l in h["lines"])]


def route(g, start, end, blocked=(), speed_kmh=WALK_KMH):
    s, t = find_station(g, start), find_station(g, end)
    end_node, prev = dijkstra(g, g["stations"][s]["hubs"], g["stations"][t]["hubs"], blocked)
    if end_node is None:
        return None
    return describe(g, s, end_node, prev, speed_kmh)


CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
STRUCT_KO = {"tunnel": "터널", "bridge": "교량", "ground": "지상", "entrance": "출입구", "underground": "지하 통로"}
SOURCE_KO = {"seoul_metro": "서울교통공사 자료", "estimated": "추정", "": ""}


def fmt_minutes(m):
    h, mm = divmod(int(m), 60)
    return f"{h}시간 {mm}분" if h else (f"{mm}분" if mm else "1분 미만")


def fmt_km(m):
    return f"{m / 1000:.1f}km"


def step_text(s):
    """단계 하나를 한국어 안내 문장(1~2줄)으로."""
    if s["type"] == "warning":
        where = s["at"] + (f" 지나 {fmt_km(s['after_m'])}" if s["after_m"] else "")
        kinds = "·".join(f"{STRUCT_KO[k]} {fmt_km(v)}" for k, v in s["structures"].items())
        until = "다시 지하로 들어갈 때까지" if s["ends_underground"] else "도착할 때까지"
        how = "터널을 나와 " if s["portal"] else ""
        return [f"   ※ 지상 노출 | {where}에서 {how}{until} {fmt_km(s['exposure_m'])} ({kinds})"]
    no = CIRCLED[s["no"] - 1] if s["no"] <= len(CIRCLED) else f"({s['no']})"
    if s["type"] == "transfer":
        where = "지하" if s["underground"] else "지상"
        return [f"{no} 환승 | {s['station']}: {s['from_line']} → {s['to_line']}, {s['distance_m']}m, 약 {fmt_minutes(s['est_minutes'])}"
                f" ({SOURCE_KO[s['source']]}, {where})"]
    nxt, head = s["direction"].replace(" 방면", ""), s["direction"]
    if "terminal_direction" in s:
        head = s["terminal_direction"] + ("" if s["terminal_direction"] == s["direction"] else f"(다음 역 {nxt})")
    passing = ", ".join(f"{p['station']} {p['at_m'] / 1000:.1f}" for p in s["passing"])
    if head:
        where = f"{s['from_station']} → {head} … {s['to_station']}까지"
    else:  # 다음 역 없이 다른 노선 선로로 이어지는 단계(분기점에서 노선이 바뀜)
        where = f"{s['from_station']} 이후 선로를 따라 다음 단계까지"
    text = f"{no} {s['label']} | {where} {fmt_km(s['distance_m'])}, 약 {fmt_minutes(s['est_minutes'])}"
    if s["exposure_m"]:
        text += f", 지상 노출 {fmt_km(s['exposure_m'])}"
    text += f" (지나는 역: {passing})" if passing else " (지나는 역 없음)"
    lines = [text]
    if len(s["track_parts"]) > 1:  # 선이 바뀌면 구간별로: '과천선 인덕원→남태령 8.9km · 4호선 남태령→사당 1.7km'
        parts = []
        for p in s["track_parts"]:
            span = f" {p['from_station']}→{p['to_station']}" if p["from_station"] != p["to_station"] else ""
            parts.append(f"{p['name']}{span} {fmt_km(p['distance_m'])}")
        lines.append("    선 구간: " + " · ".join(parts))
    return lines


def print_result(start, end, r, checkpoints=False):
    if r is None:
        print(f"{start} → {end}: 경로 없음")
        return
    print(f"{start} → {end}: 총 {r['total_m'] / 1000:.2f}km, 약 {fmt_minutes(r['est_minutes'])}(시속 {r['speed_kmh']}km), "
          f"지상 노출 {r['exposed_m'] / 1000:.2f}km, 간선 {len(r['edges'])}개")
    if checkpoints:
        print("  노선: " + " → ".join(r["lines"]))
        for cp in r["checkpoints"]:
            extra = ""
            if cp["type"] == "환승":
                extra = (f" {'/'.join(cp['from']) or '?'} → {'/'.join(cp['to']) or '?'}"
                         f" ({cp['len_m']}m, {cp['src']}, {'지하' if cp['underground'] else '지상'})")
            print(f"  {cp['at_m'] / 1000:7.2f}km  +{cp.get('leg_m', 0):5d}m  {cp['type']} {cp['name']}{extra}")
        return
    for s in r["steps"]:
        for line in step_text(s):
            print(line)


def main():
    args = sys.argv[1:]
    blocked, as_json, show_cp, speed, pos = [], False, False, WALK_KMH, []
    i = 0
    while i < len(args):
        if args[i] == "--block":
            blocked += [int(x) for x in args[i + 1].split(",") if x]
            i += 2
        elif args[i] == "--block-han":
            pos.append(("han", args[i + 1]))
            i += 2
        elif args[i] == "--speed":
            speed = float(args[i + 1])
            i += 2
        elif args[i] == "--json":
            as_json = True
            i += 1
        elif args[i] == "--checkpoints":
            show_cp = True
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
    r = route(g, names[0], names[1], blocked, speed)
    if as_json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
    else:
        print_result(names[0], names[1], r, show_cp)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
