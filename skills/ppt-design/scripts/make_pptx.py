#!/usr/bin/env python3
"""
Zero-dependency PPTX generator using Python standard library (zipfile + xml).
Generates valid, editable Microsoft PowerPoint (.pptx) presentations.
"""

import sys
import os
import json
import zipfile
import argparse
from xml.sax.saxutils import escape

CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  {SLIDE_OVERRIDES}
</Types>'''

RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>'''

PRESENTATION_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  {SLIDE_RELATIONSHIPS}
</Relationships>'''

SLIDE_LAYOUT = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:slideLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld name="Blank Layout">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
</p:slideLayout>'''

SLIDE_LAYOUT_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>'''

SLIDE_MASTER = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:slideMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rId1"/>
  </p:sldLayoutIdLst>
</p:slideMaster>'''

SLIDE_MASTER_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>'''

THEME = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Dark Tech Theme">
  <a:themeElements>
    <a:clrScheme name="Custom Dark">
      <a:dk1><a:srgbClr val="0D1117"/></a:dk1>
      <a:lt1><a:srgbClr val="F0F6FC"/></a:lt1>
      <a:dk2><a:srgbClr val="161B22"/></a:dk2>
      <a:lt2><a:srgbClr val="8B949E"/></a:lt2>
      <a:accent1><a:srgbClr val="58A6FF"/></a:accent1>
      <a:accent2><a:srgbClr val="3FB950"/></a:accent2>
      <a:accent3><a:srgbClr val="BC8CFF"/></a:accent3>
      <a:accent4><a:srgbClr val="D29922"/></a:accent4>
      <a:accent5><a:srgbClr val="F0883E"/></a:accent5>
      <a:accent6><a:srgbClr val="39C5BB"/></a:accent6>
      <a:hlink><a:srgbClr val="58A6FF"/></a:hlink>
      <a:folHlink><a:srgbClr val="BC8CFF"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Modern Font">
      <a:majorFont><a:latin typeface="Segoe UI"/><a:ea typeface="Microsoft YaHei"/></a:majorFont>
      <a:minorFont><a:latin typeface="Segoe UI"/><a:ea typeface="Microsoft YaHei"/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme>
  </a:themeElements>
</a:theme>'''

def build_slide_xml(title, bullets, is_cover=False, author=""):
    title_escaped = escape(title)
    
    if is_cover:
        author_escaped = escape(author or "DeepSeek Harness Presentation")
        return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <!-- Background Card -->
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Background"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm>
          <a:solidFill><a:srgbClr val="0D1117"/></a:solidFill>
        </p:spPr>
      </p:sp>
      <!-- Cover Title -->
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="2286000"/><a:ext cx="10363200" cy="1828800"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr anchor="ctr"/>
          <a:p>
            <a:pPr algn="ctr"/>
            <a:r><a:rPr lang="zh-CN" sz="4400" b="1"><a:solidFill><a:srgbClr val="58A6FF"/></a:solidFill></a:rPr><a:t>{title_escaped}</a:t></a:r>
          </a:p>
          <a:p>
            <a:pPr algn="ctr"/>
            <a:r><a:rPr lang="zh-CN" sz="2000"><a:solidFill><a:srgbClr val="8B949E"/></a:solidFill></a:rPr><a:t>{author_escaped}</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>'''

    # Content Slide
    bullets_xml = ""
    for bullet in bullets:
        b_escaped = escape(bullet)
        bullets_xml += f'''
          <a:p>
            <a:pPr lvl="0"><a:buChar char="✦"/></a:pPr>
            <a:r><a:rPr lang="zh-CN" sz="1800"><a:solidFill><a:srgbClr val="F0F6FC"/></a:solidFill></a:rPr><a:t>{b_escaped}</a:t></a:r>
          </a:p>'''

    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <!-- Background Card -->
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Background"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm>
          <a:solidFill><a:srgbClr val="0D1117"/></a:solidFill>
        </p:spPr>
      </p:sp>
      <!-- Slide Card -->
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Card"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="609600" y="457200"/><a:ext cx="10972800" cy="5943600"/></a:xfrm>
          <a:solidFill><a:srgbClr val="161B22"/></a:solidFill>
          <a:ln w="19050"><a:solidFill><a:srgbClr val="30363D"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <!-- Slide Title -->
      <p:sp>
        <p:nvSpPr><p:cNvPr id="4" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="762000"/><a:ext cx="10363200" cy="914400"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr anchor="t"/>
          <a:p>
            <a:r><a:rPr lang="zh-CN" sz="2800" b="1"><a:solidFill><a:srgbClr val="58A6FF"/></a:solidFill></a:rPr><a:t>{title_escaped}</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
      <!-- Bullets Content -->
      <p:sp>
        <p:nvSpPr><p:cNvPr id="5" name="Content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="1981200"/><a:ext cx="10363200" cy="4114800"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr anchor="t"/>
          {bullets_xml}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>'''

def generate_pptx(title, author, slides_data, output_path):
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    all_slides = [{"title": title, "bullets": [], "is_cover": True}] + slides_data
    num_slides = len(all_slides)

    slide_overrides = ""
    slide_relationships = ""
    presentation_slide_ids = ""

    for i in range(1, num_slides + 1):
        slide_overrides += f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>\n  '
        slide_relationships += f'<Relationship Id="rId{i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>\n  '
        presentation_slide_ids += f'<p:sldId id="{255+i}" r:id="rId{i+1}"/>\n      '

    presentation_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>
      {presentation_slide_ids}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>'''

    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES.format(SLIDE_OVERRIDES=slide_overrides))
        z.writestr('_rels/.rels', RELS)
        z.writestr('ppt/_rels/presentation.xml.rels', PRESENTATION_RELS.format(SLIDE_RELATIONSHIPS=slide_relationships))
        z.writestr('ppt/presentation.xml', presentation_xml)
        z.writestr('ppt/slideLayouts/slideLayout1.xml', SLIDE_LAYOUT)
        z.writestr('ppt/slideLayouts/_rels/slideLayout1.xml.rels', SLIDE_LAYOUT_RELS)
        z.writestr('ppt/slideMasters/slideMaster1.xml', SLIDE_MASTER)
        z.writestr('ppt/slideMasters/_rels/slideMaster1.xml.rels', SLIDE_MASTER_RELS)
        z.writestr('ppt/theme/theme1.xml', THEME)

        for i, s in enumerate(all_slides, 1):
            s_xml = build_slide_xml(s.get('title', ''), s.get('bullets', []), s.get('is_cover', False), author)
            s_rels = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>'''
            z.writestr(f'ppt/slides/slide{i}.xml', s_xml)
            z.writestr(f'ppt/slides/_rels/slide{i}.xml.rels', s_rels)

    print(f"✅ PPTX generated successfully: {output_path}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--title', required=True)
    parser.add_argument('--author', default='DeepSeek Harness')
    parser.add_argument('--slides-json', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()

    slides = json.loads(args.slides_json)
    generate_pptx(args.title, args.author, slides, args.output)
