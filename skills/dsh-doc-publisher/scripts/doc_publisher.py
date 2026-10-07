#!/usr/bin/env python3
"""
DOCX Publisher - 零外部依赖 Word (.docx) 生成引擎
使用 Python 标准库 zipfile 生成排版精美、层级分明、支持表格/多级标题的标准 DOCX 文件。
"""

import sys
import os
import zipfile
import html
import json

CONTENT_TYPES_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>'''

RELS_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

DOC_RELS_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''

STYLES_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:eastAsia="Microsoft YaHei" w:hAnsi="Calibri"/>
        <w:sz w:val="22"/>
        <w:color w:val="24292F"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:line="360" w:lineRule="auto" w:before="60" w:after="60"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
</w:styles>'''

def escape_xml(text):
    return html.escape(str(text)) if text is not None else ""

class DocxBuilder:
    def __init__(self, title=""):
        self.body_elements = []
        if title:
            self.add_title(title)

    def add_title(self, text):
        xml = f'''<w:p>
          <w:pPr>
            <w:jc w:val="center"/>
            <w:spacing w:before="240" w:after="240"/>
          </w:pPr>
          <w:r>
            <w:rPr>
              <w:b/>
              <w:sz w:val="44"/>
              <w:color w:val="1F2328"/>
            </w:rPr>
            <w:t>{escape_xml(text)}</w:t>
          </w:r>
        </w:p>'''
        self.body_elements.append(xml)

    def add_heading(self, text, level=1):
        sz = 32 if level == 1 else (28 if level == 2 else 24)
        color = "0969DA" if level == 1 else ("1F2328" if level == 2 else "57606A")
        before = 240 if level == 1 else 160
        xml = f'''<w:p>
          <w:pPr>
            <w:spacing w:before="{before}" w:after="80"/>
          </w:pPr>
          <w:r>
            <w:rPr>
              <w:b/>
              <w:sz w:val="{sz}"/>
              <w:color w:val="{color}"/>
            </w:rPr>
            <w:t>{escape_xml(text)}</w:t>
          </w:r>
        </w:p>'''
        self.body_elements.append(xml)

    def add_paragraph(self, text, bold=False, italic=False, color="24292F"):
        b_tag = "<w:b/>" if bold else ""
        i_tag = "<w:i/>" if italic else ""
        xml = f'''<w:p>
          <w:pPr>
            <w:spacing w:line="360" w:lineRule="auto" w:after="80"/>
          </w:pPr>
          <w:r>
            <w:rPr>
              {b_tag}
              {i_tag}
              <w:sz w:val="22"/>
              <w:color w:val="{color}"/>
            </w:rPr>
            <w:t xml:space="preserve">{escape_xml(text)}</w:t>
          </w:r>
        </w:p>'''
        self.body_elements.append(xml)

    def add_table(self, headers, rows):
        tbl_xml = ['<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:left w:val="none"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:right w:val="none"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="EAECEF"/><w:insideV w:val="none"/></w:tblBorders></w:tblPr>']
        
        # 表头
        tbl_xml.append('<w:tr><w:trPr><w:tblHeader/></w:trPr>')
        for h in headers:
            tbl_xml.append(f'''<w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/></w:tcPr><w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="20"/><w:color w:val="1F2328"/></w:rPr><w:t>{escape_xml(h)}</w:t></w:r></w:p></w:tc>''')
        tbl_xml.append('</w:tr>')

        # 数据行
        for r in rows:
            tbl_xml.append('<w:tr>')
            for cell in r:
                tbl_xml.append(f'''<w:tc><w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/><w:color w:val="24292F"/></w:rPr><w:t>{escape_xml(cell)}</w:t></w:r></w:p></w:tc>''')
            tbl_xml.append('</w:tr>')

        tbl_xml.append('</w:tbl>')
        self.body_elements.append(''.join(tbl_xml))

    def save(self, output_path):
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        doc_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    {''.join(self.body_elements)}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>'''

        with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('[Content_Types].xml', CONTENT_TYPES_XML)
            zf.writestr('_rels/.rels', RELS_XML)
            zf.writestr('word/_rels/document.xml.rels', DOC_RELS_XML)
            zf.writestr('word/styles.xml', STYLES_XML)
            zf.writestr('word/document.xml', doc_xml)
        return output_path

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        test_out = '/sdcard/Download/DSH_WorkLogs/test_document.docx'
        builder = DocxBuilder("项目立项与技术方案建议书")
        builder.add_heading("一、 项目背景与业务目标", level=1)
        builder.add_paragraph("随着移动端离线生产力需求的快速增长，构建端侧全功能工作流中枢具备显著的业务价值。")
        builder.add_heading("二、 核心指标对比", level=2)
        builder.add_table(["方案", "内存开销", "响应延迟", "状态"], [
            ["传统远程方案", "32MB", "1200ms", "依赖网络"],
            ["DSH 端侧直连", "8MB", "45ms", "完全离线"]
        ])
        saved = builder.save(test_out)
        print(f"DOCX 生成成功: {saved} ({os.path.getsize(saved)} 字节)")
