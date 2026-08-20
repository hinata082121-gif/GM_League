#!/usr/bin/env python3
"""
Markdown を日本語対応の PDF に変換する。

  python3 tools/build_pdf.py FEATURES.md
  python3 tools/build_pdf.py SPEC.md OPERATION.md GUIDE.md

▶ なぜこの作り方なのか

LaTeX 経由（pandoc + lualatex）だと日本語組版に ltjsarticle / ctex が要るが、
実行環境に入っていないことが多く、入っていないと行分割が破綻する。
そこで **Markdown → HTML → LibreOffice → PDF** の経路にしている。
LibreOffice はどの環境にもほぼ入っていて、日本語の行分割も自然。

▶ 注意

LibreOffice の HTML 取り込みは CSS の border をほぼ無視する。
そのため表の罫線は旧来の table 属性（border / cellpadding）で指定している。
ここを CSS だけに戻すと、罫線が消えて1列目が潰れた表になる。

必要なもの: python3-markdown, libreoffice, Noto Sans CJK JP
"""

import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

# 本文と見出しに使うフォント。CJK を含むものを指定すること
FONT_SANS = "Noto Sans CJK JP"
FONT_MONO = "Noto Sans Mono CJK JP"

CSS = f"""
@page {{ size: A4; margin: 18mm 16mm; }}
body {{
  font-family: '{FONT_SANS}';
  font-size: 10pt;
  line-height: 1.7;
  color: #1a1a1a;
}}
h1 {{
  font-size: 20pt; color: #12325e;
  border-bottom: 2pt solid #12325e;
  padding-bottom: 4pt; margin-bottom: 14pt;
}}
h2 {{
  font-size: 14pt; color: #12325e;
  border-bottom: 1pt solid #c9d2e0;
  padding-bottom: 3pt;
  margin-top: 20pt; margin-bottom: 8pt;
}}
h3 {{ font-size: 11.5pt; color: #1d3f73; margin-top: 14pt; margin-bottom: 6pt; }}
h4 {{ font-size: 10.5pt; color: #1d3f73; margin-top: 10pt; margin-bottom: 4pt; }}
p {{ margin: 6pt 0; }}
ul, ol {{ margin: 6pt 0 6pt 18pt; }}
li {{ margin: 3pt 0; }}
table {{ border-collapse: collapse; width: 100%; margin: 8pt 0 12pt 0; font-size: 9pt; }}
th {{
  background-color: #eef2f8; border: 0.5pt solid #c9d2e0;
  padding: 4pt 6pt; text-align: left; font-weight: bold; color: #12325e;
}}
td {{ border: 0.5pt solid #c9d2e0; padding: 4pt 6pt; vertical-align: top; }}
code {{ font-family: '{FONT_MONO}'; font-size: 9pt; background-color: #f2f4f8; }}
pre {{
  font-family: '{FONT_MONO}'; font-size: 8.5pt;
  background-color: #f6f8fb; border: 0.5pt solid #dfe5ee;
  padding: 6pt 8pt; line-height: 1.5;
}}
blockquote {{
  margin: 8pt 0 8pt 10pt; padding-left: 10pt;
  border-left: 2pt solid #c9d2e0; color: #444;
}}
hr {{ border: 0; border-top: 0.5pt solid #c9d2e0; margin: 14pt 0; }}
a {{ color: #1d63d1; }}
strong {{ color: #12325e; }}
"""


def md_to_html(md_path: pathlib.Path) -> str:
    """Markdown を、LibreOffice が正しく読める HTML にする。"""
    import markdown

    body = markdown.markdown(
        md_path.read_text(encoding="utf-8"),
        extensions=["tables", "fenced_code", "toc", "sane_lists", "attr_list"],
    )

    # LibreOffice は CSS の border を見ないので、table 属性で指定し直す
    body = body.replace(
        "<table>",
        '<table border="1" cellspacing="0" cellpadding="5" width="100%">',
    )
    body = re.sub(
        r"<th>",
        '<th bgcolor="#EEF2F8" style="line-height:1.35; font-size:9pt; text-align:left;">',
        body,
    )
    body = re.sub(r"<td>", '<td style="line-height:1.35; font-size:9pt;">', body)

    return (
        '<!DOCTYPE html>\n<html lang="ja">\n<head>\n'
        '<meta charset="utf-8" />\n'
        f"<title>{md_path.stem}</title>\n"
        f"<style>{CSS}</style>\n</head>\n<body>\n{body}\n</body>\n</html>"
    )


def build(md_path: pathlib.Path) -> pathlib.Path:
    """1つの Markdown から PDF を作り、同じ場所に置く。"""
    if not md_path.exists():
        raise FileNotFoundError(md_path)

    out_pdf = md_path.with_suffix(".pdf")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = pathlib.Path(tmp)
        html_path = tmp_dir / (md_path.stem + ".html")
        html_path.write_text(md_to_html(md_path), encoding="utf-8")

        subprocess.run(
            [
                "soffice", "--headless",
                "--convert-to", "pdf:writer_pdf_Export",
                "--outdir", str(tmp_dir),
                str(html_path),
            ],
            check=True,
            capture_output=True,
        )

        made = tmp_dir / (md_path.stem + ".pdf")
        if not made.exists():
            raise RuntimeError(f"PDF が生成されませんでした: {md_path}")

        shutil.copy(made, out_pdf)

    return out_pdf


def main(argv):
    targets = argv[1:] or ["FEATURES.md"]

    for name in targets:
        pdf = build(pathlib.Path(name))
        size_kb = pdf.stat().st_size // 1024
        print(f"{name} -> {pdf.name}  ({size_kb} KB)")


if __name__ == "__main__":
    main(sys.argv)
