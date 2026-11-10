# overpass_fetch.py
# 하는 일: Overpass QL 쿼리 파일 하나를 공개 Overpass API에 보내고, 응답(JSON)을 그대로 파일로 저장한다.
# 사용법: python -I scripts\overpass_fetch.py <쿼리파일.overpassql> <저장할파일.json>
# 원칙: 한 번에 하나만 요청한다. 실패하면 대체 서버로 한 번만 더 시도하고, 계속 두드리지 않는다.
import sys
import time
import urllib.parse
import urllib.request

SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "underground-route-hackathon/0.1"


def fetch(query, out_path):
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    for i, url in enumerate(SERVERS):
        if i > 0:
            time.sleep(30)  # 대체 서버로 넘어가기 전에 잠깐 쉰다
        req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=900) as resp:
                data = resp.read()
        except Exception as e:  # 시간 초과, 429, 504 등
            print(f"실패: {url} -> {e}")
            continue
        with open(out_path, "wb") as f:
            f.write(data)
        print(f"성공: {url}, {len(data):,} bytes, {time.time() - started:.0f}s")
        # Overpass는 오류도 200으로 돌려줄 때가 있어 'remark'를 확인한다
        ends = data[:2000].decode("utf-8", "replace") + data[-3000:].decode("utf-8", "replace")
        if '"remark"' in ends:
            print("경고: 응답에 remark(오류/시간 초과 표시)가 있다. 파일 끝을 확인할 것.")
        return True
    return False


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    query_file, out_file = sys.argv[1], sys.argv[2]
    with open(query_file, encoding="utf-8") as f:
        q = f.read()
    sys.exit(0 if fetch(q, out_file) else 1)
