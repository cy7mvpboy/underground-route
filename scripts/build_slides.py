"""발표 자료 만들기: slides/index.html -> web/slides/index.html

원본 HTML이 가리키는 로컬 그림(../docs/screens/*.jpg 등)을 data URI로 넣어
파일 하나로 된 발표 자료를 만든다. 인터넷 없이 USB나 메일로 옮겨도 열린다
(웹 글꼴과 QR 코드 라이브러리만 인터넷에서 받고, 못 받으면 기본 글꼴·링크만 보인다).

    python scripts/build_slides.py

Python 표준 라이브러리만 쓴다.
"""
import base64
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "slides" / "index.html"
OUT = ROOT / "web" / "slides" / "index.html"
LIMIT = 6 * 1024 * 1024   # 만든 파일이 이보다 크면 경고한다

MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".gif": "image/gif",
}
# src="../…", href="../…", url(../…) 중 그림 파일
REF = re.compile(r"""(?P<pre>(?:src|href)=(?P<q>["'])|url\((?P<uq>["']?))(?P<path>\.{1,2}/[^"')]+?\.(?:jpe?g|png|webp|svg|gif))(?=(?P=q)|["']?\))""", re.I)


def main():
    if not sys.stdout.isatty():   # 파일·파이프로 내보낼 때도 한글이 깨지지 않게
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    html = SRC.read_text(encoding="utf-8")
    cache, missing, used = {}, [], []

    def inline(m):
        rel = m.group("path")
        path = (SRC.parent / rel).resolve()
        if rel not in cache:
            if not path.is_file():
                missing.append(rel)
                return m.group(0)
            data = path.read_bytes()
            used.append((rel, len(data)))
            cache[rel] = "data:%s;base64,%s" % (MIME[path.suffix.lower()], base64.b64encode(data).decode("ascii"))
        return m.group("pre") + cache[rel]

    out = REF.sub(inline, html)
    if missing:
        sys.exit("그림 파일이 없습니다: " + ", ".join(missing))
    left = re.findall(r"""(?:src|href)=["'](\.\.?/[^"']+)""", out)
    if left:
        sys.exit("data URI로 바꾸지 못한 로컬 참조가 있습니다: " + ", ".join(left))

    note = "<!-- 이 파일은 scripts/build_slides.py 가 slides/index.html 에서 만든다. 고칠 때는 원본을 고치고 다시 만든다. -->\n"
    out = out.replace("<!doctype html>\n", "<!doctype html>\n" + note, 1)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(out, encoding="utf-8", newline="\n")

    size = OUT.stat().st_size
    for rel, n in used:
        print("  %-48s %7.1f KB" % (rel, n / 1024))
    print("그림 %d개 · %s -> %s · %.2f MB" % (len(used), SRC.relative_to(ROOT), OUT.relative_to(ROOT), size / 1048576))
    if size > LIMIT:
        print("경고: %.1f MB 보다 큽니다. 작은 스크린샷을 쓰거나 JPEG 품질을 낮추세요." % (LIMIT / 1048576))


if __name__ == "__main__":
    main()
