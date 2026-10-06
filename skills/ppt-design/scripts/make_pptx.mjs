import pptxgen from 'pptxgenjs';

async function main() {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';

  // 1. 封面页 (深色科技风 - 黄金分割安全边距)
  const slide1 = pptx.addSlide();
  slide1.background = { color: '0D1117' };

  slide1.addText('DeepSeek Harness', {
    x: 1.0,
    y: 1.8,
    w: 11.3,
    h: 0.9,
    fontSize: 42,
    bold: true,
    color: '58A6FF',
    fontFace: 'Microsoft YaHei'
  });

  slide1.addText('安卓端智能体生态全景与五大技能实装', {
    x: 1.0,
    y: 2.8,
    w: 11.3,
    h: 0.6,
    fontSize: 20,
    color: '8B949E',
    fontFace: 'Microsoft YaHei'
  });

  slide1.addText('汇报人：19岁少年与DSH | 2026年10月', {
    x: 1.0,
    y: 4.2,
    w: 11.3,
    h: 0.4,
    fontSize: 14,
    color: '484F58',
    fontFace: 'Microsoft YaHei'
  });

  // 2. 核心架构与愿景 (紧凑精致卡片)
  const slide2 = pptx.addSlide();
  slide2.background = { color: '0D1117' };

  slide2.addShape(pptx.ShapeType.roundRect, {
    x: 0.8, y: 0.5, w: 11.7, h: 0.7,
    fill: { color: '161B22' }, line: { color: '30363D', width: 1 }, rectRadius: 0.08
  });
  slide2.addText('🎯 项目愿景与架构突破', {
    x: 1.1, y: 0.55, w: 10, h: 0.6,
    fontSize: 20, bold: true, color: '58A6FF', fontFace: 'Microsoft YaHei'
  });

  const cards2 = [
    { title: '自主编译与自进化', desc: '在安卓手机上实现独立源码构建、签名与自我升级，完全摆脱对PC电脑的依赖。', color: '1F6FEB' },
    { title: '纯净专线网络', desc: '接入 IEPL 全专线与加州 GPT 原生落地通道，彻底规避平台风控。', color: '238636' },
    { title: '跨会话记忆库', desc: '基于 SQLite 本地沉淀事实与教训，按需加权召回，告别开局失忆。', color: '8957E5' }
  ];

  cards2.forEach((c, idx) => {
    const posX = 0.8 + idx * 4.0;
    slide2.addShape(pptx.ShapeType.roundRect, {
      x: posX, y: 1.5, w: 3.7, h: 3.6,
      fill: { color: '161B22' }, line: { color: c.color, width: 1.5 }, rectRadius: 0.12
    });
    slide2.addText(c.title, {
      x: posX + 0.25, y: 1.75, w: 3.2, h: 0.5,
      fontSize: 17, bold: true, color: 'F0F6FC', fontFace: 'Microsoft YaHei'
    });
    slide2.addText(c.desc, {
      x: posX + 0.25, y: 2.35, w: 3.2, h: 2.5,
      fontSize: 13, color: '8B949E', fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.2
    });
  });

  // 3. 五大技能矩阵 (紧凑条带)
  const slide3 = pptx.addSlide();
  slide3.background = { color: '0D1117' };

  slide3.addShape(pptx.ShapeType.roundRect, {
    x: 0.8, y: 0.5, w: 11.7, h: 0.7,
    fill: { color: '161B22' }, line: { color: '30363D', width: 1 }, rectRadius: 0.08
  });
  slide3.addText('🚀 五大杀手级随包技能矩阵', {
    x: 1.1, y: 0.55, w: 10, h: 0.6,
    fontSize: 20, bold: true, color: '58A6FF', fontFace: 'Microsoft YaHei'
  });

  const skills = [
    { name: '1. archify', desc: '高颜值架构图内联渲染，告别难看纯文本 ASCII' },
    { name: '2. ppt-design', desc: '基于 pptxgenjs 一键自动化生成真实可编辑演示文稿' },
    { name: '3. memos', desc: '跨会话长期记忆中枢，永久沉淀经验与避坑指南' },
    { name: '4. browser-skill', desc: '公开网页与带登录态后台数据自动清洗提取' },
    { name: '5. vox-director', desc: 'VOX 风格纸拼贴解说短视频分镜与视觉指导' }
  ];

  skills.forEach((s, idx) => {
    const posY = 1.45 + idx * 0.72;
    slide3.addShape(pptx.ShapeType.roundRect, {
      x: 0.8, y: posY, w: 11.7, h: 0.62,
      fill: { color: '161B22' }, line: { color: '30363D', width: 1 }, rectRadius: 0.08
    });
    slide3.addText(s.name, {
      x: 1.1, y: posY + 0.06, w: 2.8, h: 0.5,
      fontSize: 15, bold: true, color: '3FB950', fontFace: 'Microsoft YaHei'
    });
    slide3.addText(s.desc, {
      x: 4.0, y: posY + 0.06, w: 8.2, h: 0.5,
      fontSize: 13, color: 'C9D1D9', fontFace: 'Microsoft YaHei'
    });
  });

  await pptx.writeFile({ fileName: '/sdcard/DeepSeekHarness/demo.pptx' });
  console.log('✅ Polished PPTX generated!');
}

main().catch(console.error);
