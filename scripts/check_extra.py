# check_extra.py
# 하는 일: web\data\extra.json의 빠른 환승(fast) 항목이 실제 경로의 환승에 맞는지 본다.
#   시험 경로를 route.py로 찾고, 환승 단계마다 (환승역, 타던 노선, 갈아탈 노선, 걸어온 앞 역, 갈아탄 뒤 다음 역)으로
#   fast 항목을 고른 뒤, 걷는 방향이 그 열차 방향과 같은지(앞 역 == prev)에 따라 위치(front/middle/back)를 정한다.
#   경로에 나오지 않는 환승도 직접 지정해 같은 방식으로 본다.
# 사용법(프로젝트 폴더에서): python -I scripts\check_extra.py
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))  # -I 모드에서도 옆 스크립트를 불러오기 위해
import route  # noqa: E402

EXTRA = os.path.join(ROOT, "web", "data", "extra.json")
ROUTES = [("서울역", "강남"), ("부평", "구로")]
# 경로와 상관없이 직접 보는 환승: (환승역, 타던 노선, 갈아탈 노선, 걸어온 앞 역, 갈아탄 뒤 다음 역)
MANUAL = [
    ("공덕", "공항철도", "5호선", "서울역", "마포"),
    ("여의도", "5호선", "9호선", "여의나루", "샛강"),
    ("신논현", "9호선", "신분당선", "사평", "강남"),
    ("신도림", "2호선", "1호선", "대림", "구로"),
]
MIRROR = {"front": "back", "back": "front", "middle": "middle"}


def station_on_line(g, name, line):
    """이름이 같고 노선 line 허브가 있는 역 번호(없으면 이름만 같은 첫 역)."""
    key = route.normalize_name(name)
    hits = [i for i, s in enumerate(g["stations"]) if key in s["names"]]
    on = [i for i in hits if any(line in g["hub_lines"][h] for h in g["stations"][i]["hubs"])]
    return (on or hits or [None])[0]


def match(g, x, s, line, to_line, prev, nxt):
    """fast 항목 고르기. 돌려주는 값: (항목, 같은 방향 여부, 걷는 사람 기준 위치, 설명) 또는 (None, ..., 이유)."""
    L = g["tables"]["lines"]
    li, ti = L.index(line), L.index(to_line)
    at_s = [e for e in x["fast"] if e["s"] == s]
    if not at_s:
        return None, None, None, "이 역의 fast 항목 없음"
    pair = [e for e in at_s if e["line"] == li and e["to_line"] == ti]
    if not pair:
        have = sorted({f"{L[e['line']]}→{L[e['to_line']]}" for e in at_s})
        return None, None, None, f"{line}→{to_line} 항목 없음(이 역에 있는 것: {', '.join(have)})"
    with_next = [e for e in pair if e["next"] == nxt] or [e for e in pair if e["next"] is None] or pair
    same = [e for e in with_next if prev == e["prev"] or prev in e.get("prev_alt", ())]
    if same:
        e = same[0]
        return e, True, e["pos"], "같은 방향(앞 역 = prev)"
    e = with_next[0]
    return e, False, MIRROR[e["pos"]], "반대 방향 → 앞·뒤 뒤집음" if e["prev"] is not None else "prev 없음 → 뒤집음"


def show(g, x, s, line, to_line, prev, nxt):
    S, L = g["stations"], g["tables"]["lines"]
    nm = lambda i: S[i]["name"] if i is not None else "-"
    print(f"  {nm(s)}: {line} → {to_line} (앞 역 {nm(prev)}, 다음 역 {nm(nxt)})")
    e, same, pos, why = match(g, x, s, line, to_line, prev, nxt)
    if e is None:
        print(f"    맞는 항목 없음: {why}")
        return
    print(f"    항목: {e['toward']} 방면 열차 {e['car']}-{e['door']} ({e['car']}/{e['cars']}량, {e['pos']}),"
          f" prev {nm(e['prev'])}{' +' + ','.join(nm(p) for p in e.get('prev_alt', [])) if e.get('prev_alt') else ''},"
          f" 환승 뒤 {e['next_name'] or '-'}")
    print(f"    → 걷는 방향 기준 '{pos}' ({why})")
    others = [o for o in x["fast"] if o["s"] == s and o["line"] == e["line"] and o["to_line"] == e["to_line"]
              and o["next"] == e["next"] and o is not e]
    for o in others:  # 반대 방향 열차 항목과 맞는지(같은 계단이면 뒤집은 위치가 같아야 한다)
        print(f"    (참고) {o['toward']} 방면 {o['car']}-{o['door']} {o['pos']}, prev {nm(o['prev'])}")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    os.chdir(ROOT)
    g = route.load_graph()
    with open(EXTRA, encoding="utf-8") as f:
        x = json.load(f)
    for a, b in ROUTES:
        r = route.route(g, a, b)
        print(f"[경로] {a} → {b}: {r['total_m']:,}m, 노선 {' → '.join(r['lines'])}")
        steps = [s for s in r["steps"] if s["type"] != "warning"]
        for n, st in enumerate(steps):
            if st["type"] != "transfer":
                continue
            before = steps[n - 1] if n > 0 and steps[n - 1]["type"] == "ride" else None
            after = steps[n + 1] if n + 1 < len(steps) and steps[n + 1]["type"] == "ride" else None
            if not before or not after:
                print(f"  {st['station']}: 앞뒤 타기 단계가 없어 건너뜀")
                continue
            line, to_line = before["line_full"], after["line_full"]
            prev_name = before["passing"][-1]["station"] if before["passing"] else before["from_station"]
            next_name = after["passing"][0]["station"] if after["passing"] else after["to_station"]
            s = station_on_line(g, st["station"], line)
            show(g, x, s, line, to_line, station_on_line(g, prev_name, line), station_on_line(g, next_name, to_line))
    print("[직접 지정한 환승]")
    for st, line, to_line, p, n in MANUAL:
        show(g, x, station_on_line(g, st, line), line, to_line, station_on_line(g, p, line), station_on_line(g, n, to_line))


if __name__ == "__main__":
    main()
