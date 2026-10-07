#!/usr/bin/env python3
"""
Excel Copilot - 零外部依赖 Excel (.xlsx) 与复杂多表对齐引擎
使用 Python 标准库 zipfile 生成带表头样式、自适应列宽、公式（SUM/AVG）的标准 XLSX 表格。
"""

import sys
import os
import zipfile
import html
import csv

CONTENT_TYPES_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>'''

RELS_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>'''

WB_RELS_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''

WORKBOOK_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>'''

STYLES_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0969DA"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/></border>
    <border>
      <left style="thin"><color rgb="FFD0D7DE"/></left>
      <right style="thin"><color rgb="FFD0D7DE"/></right>
      <top style="thin"><color rgb="FFD0D7DE"/></top>
      <bottom style="thin"><color rgb="FFD0D7DE"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
</styleSheet>'''

def col_letter(col_idx):
    """0 -> A, 1 -> B, 26 -> AA"""
    result = ""
    col_idx += 1
    while col_idx > 0:
        col_idx, remainder = divmod(col_idx - 1, 26)
        result = chr(65 + remainder) + result
    return result

class XlsxBuilder:
    def __init__(self):
        self.headers = []
        self.rows = []
        self.formulas = {} # (row, col) -> formula string

    def set_headers(self, headers):
        self.headers = list(headers)

    def add_row(self, row_data):
        self.rows.append(list(row_data))

    def add_formula_cell(self, row_idx, col_idx, formula, display_val=""):
        self.formulas[(row_idx, col_idx)] = (formula, display_val)

    def save(self, output_path):
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        
        sheet_rows = []
        current_row_idx = 1

        # 表头行 (Style 1: 蓝底白字居中加粗)
        if self.headers:
            c_xml = []
            for col_i, h in enumerate(self.headers):
                cell_ref = f"{col_letter(col_i)}{current_row_idx}"
                escaped = html.escape(str(h))
                c_xml.append(f'<c r="{cell_ref}" t="inlineStr" s="1"><is><t>{escaped}</t></is></c>')
            sheet_rows.append(f'<row r="{current_row_idx}" ht="24" customHeight="1">{"".join(c_xml)}</row>')
            current_row_idx += 1

        # 数据行
        for r_i, r in enumerate(self.rows):
            c_xml = []
            for col_i, cell in enumerate(r):
                cell_ref = f"{col_letter(col_i)}{current_row_idx}"
                if (current_row_idx, col_i) in self.formulas:
                    formula, d_val = self.formulas[(current_row_idx, col_i)]
                    c_xml.append(f'<c r="{cell_ref}" s="2"><f>{html.escape(formula)}</f><v>{html.escape(str(d_val))}</v></c>')
                else:
                    is_num = False
                    try:
                        float(cell)
                        is_num = not str(cell).startswith("0") or str(cell) == "0"
                    except (ValueError, TypeError):
                        pass
                    
                    if is_num:
                        c_xml.append(f'<c r="{cell_ref}" s="2"><v>{cell}</v></c>')
                    else:
                        escaped = html.escape(str(cell))
                        c_xml.append(f'<c r="{cell_ref}" t="inlineStr" s="0"><is><t>{escaped}</t></is></c>')
            sheet_rows.append(f'<row r="{current_row_idx}" ht="20" customHeight="1">{"".join(c_xml)}</row>')
            current_row_idx += 1

        sheet_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>
    <col min="1" max="20" width="18" customWidth="1"/>
  </cols>
  <sheetData>
    {''.join(sheet_rows)}
  </sheetData>
</worksheet>'''

        with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('[Content_Types].xml', CONTENT_TYPES_XML)
            zf.writestr('_rels/.rels', RELS_XML)
            zf.writestr('xl/_rels/workbook.xml.rels', WB_RELS_XML)
            zf.writestr('xl/workbook.xml', WORKBOOK_XML)
            zf.writestr('xl/styles.xml', STYLES_XML)
            zf.writestr('xl/worksheets/sheet1.xml', sheet_xml)
        return output_path

def merge_csv_files(file_paths, output_xlsx):
    """智能对齐多个 CSV 文件表头并合并生成母表 XLSX"""
    all_headers = []
    header_map = {}
    datasets = []

    for fp in file_paths:
        with open(fp, 'r', encoding='utf-8', errors='ignore') as f:
            reader = csv.reader(f)
            raw_h = next(reader, None)
            if not raw_h:
                continue
            rows = list(reader)
            datasets.append((raw_h, rows))
            for h in raw_h:
                norm_h = h.strip()
                if norm_h not in header_map:
                    header_map[norm_h] = len(all_headers)
                    all_headers.append(norm_h)

    builder = XlsxBuilder()
    builder.set_headers(all_headers)

    for raw_h, rows in datasets:
        for r in rows:
            aligned_row = [""] * len(all_headers)
            for idx, val in enumerate(r):
                if idx < len(raw_h):
                    col_name = raw_h[idx].strip()
                    target_idx = header_map[col_name]
                    aligned_row[target_idx] = val
            builder.add_row(aligned_row)

    return builder.save(output_xlsx)

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        test_out = '/sdcard/Download/DSH_WorkLogs/test_sheet.xlsx'
        builder = XlsxBuilder()
        builder.set_headers(["部门", "渠道", "订单数", "销售额 (元)", "状态"])
        builder.add_row(["华东一区", "抖音直播", 1200, 360000, "达标"])
        builder.add_row(["华北二区", "微信私域", 850, 255000, "达标"])
        builder.add_row(["华南三区", "快手小店", 430, 129000, "预警"])
        
        # 注入求和行与公式
        builder.add_row(["合计汇总", "-", "-", "", "-"])
        builder.add_formula_cell(5, 3, "SUM(D2:D4)", "744000")
        
        saved = builder.save(test_out)
        print(f"XLSX 生成成功: {saved} ({os.path.getsize(saved)} 字节)")
