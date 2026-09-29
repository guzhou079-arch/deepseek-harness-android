import re, sys
fav = "/data/user/0/com.deepseek.harness/files/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg"
src = open(fav, encoding="utf-8").read()
m = re.search(r'<path[^>]*\bd="([^"]+)"', src)
whale = m.group(1)

W, H = 1080, 2340
stars = []
# 固定种子：手写一组坐标，分布在中上部，避免每帧变化
coords = [(60,180),(190,90),(300,260),(430,120),(560,60),(690,210),(820,140),(960,300),
          (120,420),(250,560),(380,470),(520,640),(660,520),(800,600),(1010,500),
          (90,760),(300,980),(470,860),(640,1100),(830,900),(990,1180),
          (140,1420),(360,1560),(600,1700),(760,1520),(930,1680),
          (220,1900),(430,2050),(680,2160),(880,1980)]
for i,(x,y) in enumerate(coords):
    r = 1.1 + (i % 4) * 0.55
    o = 0.10 + (i % 5) * 0.045
    stars.append(f'<circle cx="{x}" cy="{y}" r="{r:.1f}" fill="#cfe0ff" fill-opacity="{o:.2f}"/>')

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}"
     preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#0c1428"/>
      <stop offset="0.45" stop-color="#0a1020"/>
      <stop offset="1" stop-color="#06080f"/>
    </linearGradient>
    <radialGradient id="glowA" cx="0.16" cy="0.08" r="0.72">
      <stop offset="0" stop-color="#3b6bff" stop-opacity="0.42"/>
      <stop offset="0.55" stop-color="#2a4bd0" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#2a4bd0" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="0.92" cy="0.72" r="0.78">
      <stop offset="0" stop-color="#7b4dff" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="#5a34c8" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#5a34c8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowC" cx="0.45" cy="0.42" r="0.62">
      <stop offset="0" stop-color="#12c8ff" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#12c8ff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vig" cx="0.5" cy="0.46" r="0.78">
      <stop offset="0.45" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.55"/>
    </radialGradient>
    <linearGradient id="whaleFade" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0" stop-color="#eaf2ff" stop-opacity="0.17"/>
      <stop offset="0.6" stop-color="#cfe0ff" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#9fc0ff" stop-opacity="0.04"/>
    </linearGradient>
  </defs>

  <rect width="{W}" height="{H}" fill="url(#base)"/>
  <rect width="{W}" height="{H}" fill="url(#glowA)"/>
  <rect width="{W}" height="{H}" fill="url(#glowB)"/>
  <rect width="{W}" height="{H}" fill="url(#glowC)"/>
  <g>{"".join(stars)}</g>

  <!-- DeepSeek 鲸鱼水印（取自 dist/favicon.svg 的官方 path） -->
  <g transform="translate(90,820) scale(18)" fill="url(#whaleFade)" fill-rule="nonzero">
    <path d="{whale}"/>
  </g>

  <rect width="{W}" height="{H}" fill="url(#vig)"/>
</svg>
'''
out = sys.argv[1]
open(out, "w", encoding="utf-8").write(svg)
print("written", out, len(svg), "bytes; whale path len", len(whale))
