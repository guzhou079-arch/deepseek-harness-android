#!/usr/bin/env python3
"""doc_tidy —— 纯标准库的 Office 文档读取器（xlsx / docx / pptx）。

为什么不用 openpyxl / python-docx：
  随包分发的技能必须**零第三方依赖**（payload 里的 python 是干净的 3.14 + stdlib）。
  而 xlsx/docx/pptx 本质都是 zip + XML —— 标准库完全够读，且比点 WPS 界面稳 100 倍。

用法:
  doc_tidy.py info  <file>     # JSON 摘要：类型 / 表名 / 行列数 / 表头 / 前几行
  doc_tidy.py text  <file>     # 纯文本（xlsx 输出 TSV，docx/pptx 输出正文）
  doc_tidy.py selftest         # 自测：现场造一个 xlsx + docx 再读回来（不依赖任何外部文件）
"""
import json
import os
import re
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET


def local(tag):
    return tag.rsplit("}", 1)[-1]


def _xml(z, name):
    with z.open(name) as f:
        return ET.fromstring(f.read())


def _texts(el):
    return "".join(x.text or "" for x in el.iter() if local(x.tag) == "t")


# ---------------------------------------------------------------- xlsx
def _shared_strings(z, names):
    out = []
    if "xl/sharedStrings.xml" in names:
        for si in _xml(z, "xl/sharedStrings.xml"):
            out.append(_texts(si))
    return out


def _cell(c, shared):
    t = c.get("t")
    if t == "inlineStr":
        el = c.find(".//{*}is")
        return _texts(el) if el is not None else ""
    v = c.find("{*}v")
    if v is None or v.text is None:
        return ""
    if t == "s":
        try:
            return shared[int(v.text)]
        except Exception:
            return ""
    return v.text


def _col(ref):
    m = re.match(r"([A-Z]+)", ref or "")
    if not m:
        return 0
    n = 0
    for ch in m.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_xlsx(path):
    sheets = []
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        shared = _shared_strings(z, names)
        rels = {}
        if "xl/_rels/workbook.xml.rels" in names:
            for r in _xml(z, "xl/_rels/workbook.xml.rels"):
                rels[r.get("Id")] = r.get("Target") or ""
        wb = _xml(z, "xl/workbook.xml")
        for sh in wb.iter():
            if local(sh.tag) != "sheet":
                continue
            rid = next((v for k, v in sh.attrib.items() if k.endswith("}id") or k == "id"), None)
            target = rels.get(rid, "")
            if target.startswith("/"):
                target = target[1:]
            elif not target.startswith("xl/"):
                target = "xl/" + target.lstrip("./")
            rows = []
            if target in names:
                for row in _xml(z, target).iter():
                    if local(row.tag) != "row":
                        continue
                    cells = {}
                    for c in row:
                        if local(c.tag) == "c":
                            cells[_col(c.get("r"))] = _cell(c, shared)
                    if cells:
                        rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
            sheets.append({"name": sh.get("name") or "", "rows": rows})
    return {"type": "xlsx", "sheets": sheets}


# ---------------------------------------------------------------- docx / pptx
def read_docx(path):
    with zipfile.ZipFile(path) as z:
        root = _xml(z, "word/document.xml")
    paras = []
    for p in root.iter():
        if local(p.tag) != "p":
            continue
        buf = []
        for node in p.iter():
            lt = local(node.tag)
            if lt == "t":
                buf.append(node.text or "")
            elif lt == "br":
                buf.append("\n")
            elif lt == "tab":
                buf.append("\t")
        paras.append("".join(buf))
    return {"type": "docx", "paragraphs": paras}


def read_pptx(path):
    slides = []
    with zipfile.ZipFile(path) as z:
        names = sorted(n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n))
        for n in names:
            slides.append(_texts(_xml(z, n)))
    return {"type": "pptx", "slides": slides}


def read_any(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".xlsx" or ext == ".xlsm":
        return read_xlsx(path)
    if ext == ".docx":
        return read_docx(path)
    if ext == ".pptx":
        return read_pptx(path)
    if ext in (".doc", ".xls", ".ppt"):
        raise SystemExit("✗ 旧版二进制格式（%s）读不了：请先另存为 xlsx/docx/pptx" % ext)
    if ext == ".pdf":
        raise SystemExit("✗ PDF 读不了：本机没有 pdf 库，也没有 pdftotext")
    raise SystemExit("✗ 不认识的类型：%s" % ext)


# ---------------------------------------------------------------- 命令
def cmd_info(path):
    d = read_any(path)
    if d["type"] == "xlsx":
        out = {"file": os.path.basename(path), "type": "xlsx", "sheets": []}
        for s in d["sheets"]:
            rows = s["rows"]
            out["sheets"].append({
                "name": s["name"],
                "rows": len(rows),
                "cols": max((len(r) for r in rows), default=0),
                "header": rows[0] if rows else [],
                "preview": rows[1:6],
            })
    elif d["type"] == "docx":
        ps = [p for p in d["paragraphs"]]
        out = {"file": os.path.basename(path), "type": "docx", "paragraphs": len(ps),
               "chars": sum(len(p) for p in ps), "head": [p for p in ps if p.strip()][:8]}
    else:
        out = {"file": os.path.basename(path), "type": "pptx", "slides": len(d["slides"]),
               "head": [s[:120] for s in d["slides"][:3]]}
    return json.dumps(out, ensure_ascii=False, indent=1)


def cmd_text(path):
    d = read_any(path)
    if d["type"] == "xlsx":
        parts = []
        for s in d["sheets"]:
            parts.append("### sheet: %s" % s["name"])
            for r in s["rows"]:
                parts.append("\t".join(str(x).replace("\t", " ") for x in r))
        return "\n".join(parts)
    if d["type"] == "docx":
        return "\n".join(d["paragraphs"])
    return "\n\n".join("### slide %d\n%s" % (i + 1, t) for i, t in enumerate(d["slides"]))


# ---------------------------------------------------------------- 自测
_CT = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

_WB = """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="成绩" sheetId="1" r:id="rId1"/><sheet name="名单" sheetId="2" r:id="rId2"/></sheets></workbook>"""

_WB_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>"""

_SS = """<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5">
<si><t>姓名</t></si><si><t>分数</t></si><si><t>张三</t></si><si><t>李四</t></si><si><t>备注</t></si></sst>"""

_S1 = """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>91</v></c></row>
<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>78</v></c></row>
</sheetData></worksheet>"""

_S2 = """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>备注</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>合计 2 人</t></is></c></row>
</sheetData></worksheet>"""

_DOC = """<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>第一段：云技术实施</w:t></w:r></w:p>
<w:p><w:r><w:t>第二段：</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>成绩已汇总</w:t></w:r></w:p>
</w:body></w:document>"""


def selftest():
    d = tempfile.mkdtemp(prefix="doctidy-")
    x = os.path.join(d, "t.xlsx")
    with zipfile.ZipFile(x, "w") as z:
        z.writestr("[Content_Types].xml", _CT)
        z.writestr("_rels/.rels", _RELS)
        z.writestr("xl/workbook.xml", _WB)
        z.writestr("xl/_rels/workbook.xml.rels", _WB_RELS)
        z.writestr("xl/sharedStrings.xml", _SS)
        z.writestr("xl/worksheets/sheet1.xml", _S1)
        z.writestr("xl/worksheets/sheet2.xml", _S2)
    w = os.path.join(d, "t.docx")
    with zipfile.ZipFile(w, "w") as z:
        z.writestr("[Content_Types].xml", _CT)
        z.writestr("_rels/.rels", _RELS)
        z.writestr("word/document.xml", _DOC)

    info = json.loads(cmd_info(x))
    assert [s["name"] for s in info["sheets"]] == ["成绩", "名单"], info
    assert info["sheets"][0]["header"] == ["姓名", "分数"], info
    assert info["sheets"][0]["preview"][0] == ["张三", "91"], info
    assert info["sheets"][1]["header"] == ["备注"], info
    ts = cmd_text(x)
    assert "张三\t91" in ts and "合计 2 人" in ts, ts
    di = json.loads(cmd_info(w))
    assert di["paragraphs"] == 2 and di["chars"] > 10, di
    assert "第一段：云技术实施" in cmd_text(w)
    print("✅ selftest 通过：xlsx（2 表/共享串/内联串/数字）+ docx（段落/tab）都能正确读回")
    print("   临时样例目录：%s" % d)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "selftest":
        selftest()
    elif cmd in ("info", "text") and len(sys.argv) > 2:
        print(cmd_info(sys.argv[2]) if cmd == "info" else cmd_text(sys.argv[2]))
    else:
        print(__doc__)
        sys.exit(2)
