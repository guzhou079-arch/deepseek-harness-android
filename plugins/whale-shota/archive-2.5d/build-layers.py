#!/usr/bin/env python3
"""whale-shota 2.5D 分层：从单张插画里做出可动的两个图层。

思路
----
1) 抠像用「从边框洪泛填充」而不是颜色阈值：这样兜帽上的白色大眼/白边
   因为被蓝色包围、不与边框连通，会被正确保留为角色。
2) 产出**透明剪影**（不是卡片）：头一动，露出来的是界面本身，不需要 inpaint。
   唯一要处理的是脖子接缝 —— 用「头层向下多留一段裙边」盖住。
3) 裁切上避开了笔记本电脑：只取到 y≈6.98 格，底边做羽化淡出。

⚠ 踩过的坑（别再犯）
- **种子不能取角色像素**：裁切边上有角色的头发，从那里洪泛会把头发啃掉一块。
- **清扫必须在大膨胀之前做**：先 dilation(5) 会把「气泡文字 / 笔记本边缘」和角色
  并成一个连通域，之后再按连通域筛就永远筛不掉（实测 fg 只剩 1 个分量）。
- **toybox grep 的 `\\|` 不匹配**，验证脚本时别用它。

坐标一律用源图的 0~1 比例；改裁切只改 CROP / CUT_*。
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "assets", "whale-shota.png")
OUT = os.path.join(ROOT, "layers")
DBG = os.path.join(ROOT, "preview")
os.makedirs(OUT, exist_ok=True)

# ---- 参数 ----------------------------------------------------------------
CROP = (0.04, 0.10, 8.58 / 10, 6.98 / 10)   # left, top, right, bottom（比例）
WORK_W = 520                                 # 图层工作宽度
FILL_THRESH = 42                             # 洪泛容差
CUT_BODY = 5.72 / 10                         # 身体层上边界（比例，源图 y）
CUT_HEAD = 5.94 / 10                         # 头层下边界（含裙边，> CUT_BODY）
FEATHER_BOTTOM = 0.13                        # 底边羽化带宽（占裁切高度比例）
FONT = "/system/fonts/NotoSansCJK-Regular.ttc"

MAGIC = (255, 0, 255)


def disk(r: int) -> np.ndarray:
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r


def is_char(px) -> bool:
    """角色色（蓝 / 肤色）。判据必须够「饱和」：浅蓝墙面 (200,215,235) 只差
    b-r=35、b-g=20，木桌 (190,150,120) 也像肤色 —— 太松会把背景当角色。
    """
    r, g, b = int(px[0]), int(px[1]), int(px[2])
    blue = (b - r) > 55 and (b - g) > 25 and b > 110
    skin = r > 195 and g > 155 and 12 < (r - b) < 62
    return blue or skin


def flood_background(rgb: Image.Image) -> np.ndarray:
    """从边框多点洪泛，返回「背景」布尔掩码（True=背景）。"""
    work = rgb.copy()
    w, h = work.size

    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    for x in range(0, w, 3):
        seeds.append((x, 0))
        seeds.append((x, h - 1))
    for y in range(0, h, 3):
        seeds.append((0, y))
        seeds.append((w - 1, y))

    seen = set()
    for s in seeds:
        if s in seen:
            continue
        seen.add(s)
        if is_char(rgb.getpixel(s)):      # 角色像素 → 不种子
            continue
        if work.getpixel(s) == MAGIC:     # 已被填过
            continue
        try:
            ImageDraw.floodfill(work, s, MAGIC, thresh=FILL_THRESH)
        except Exception:
            pass

    arr = np.asarray(work)
    return (arr[:, :, 0] == 255) & (arr[:, :, 1] == 0) & (arr[:, :, 2] == 255)


def drop_corner_scraps(fg: np.ndarray, rgb: np.ndarray, ratio: float, label: str) -> np.ndarray:
    """丢掉「左右下角的小碎块」：原图气泡文字（就/了）、笔记本边缘、桌面。
    主分量无条件保留。**必须在膨胀之前调用**，否则它们已和角色连成一体。
    """
    lab, n = ndimage.label(fg)
    if not n:
        return fg
    sizes = ndimage.sum(fg, lab, range(1, n + 1))
    biggest = int(np.argmax(sizes)) + 1
    h, w = fg.shape
    keep = np.zeros_like(fg)
    dropped = []
    for i in range(1, n + 1):
        comp = lab == i
        if i == biggest:
            keep |= comp
            continue
        if sizes[i - 1] < sizes.max() * ratio:
            ys, xs = np.where(comp)
            cy, cx = ys.mean() / h, xs.mean() / w
            if cy > 0.55 and (cx < 0.28 or cx > 0.82) and not is_char(rgb[comp].mean(axis=0)):
                dropped.append((i, int(sizes[i - 1]), round(cx, 2), round(cy, 2)))
                continue
        keep |= comp
    print("  [%s] 连通域 %d 个，最大 %d px，丢掉角落碎块 %d 个 %s"
          % (label, n, sizes.max(), len(dropped), dropped if dropped else ""))
    return keep


def hand_cleanup(alpha: np.ndarray, rgb: Image.Image) -> np.ndarray:
    """定点清扫两处实测确认的残渣（位置由「按行游程」量出来，不是拍的）。

    A) 左下：原图气泡文字「就/了」在 x 31~71、y 306~358；角色左缘同一批行上是
       x≥85，两者只在 y≈314 粘了一行 → 直接按位置切，不会伤到角色。
    B) 右下：笔记本/桌面亮块在 x≥486、y≥282；角色在同一区域是蓝色 →
       只切「不是角色色」的像素。
    """
    h, w = alpha.shape
    yy, xx = np.mgrid[0:h, 0:w]

    box_a = (xx < w * 0.15) & (yy > h * 0.78)
    n_a = int(((alpha > 0) & box_a).sum())
    alpha[box_a] = 0

    box_b = (xx > w * 0.88) & (yy > h * 0.66)
    n_b = 0
    if box_b.any():
        sel = np.asarray(rgb)[box_b].astype(np.int16)
        r, g, b = sel[:, 0], sel[:, 1], sel[:, 2]
        ok = ((b - r) > 55) & ((b - g) > 25) & (b > 110)
        ok |= (r > 195) & (g > 155) & ((r - b) > 12) & ((r - b) < 62)
        kill = np.zeros(box_b.shape, dtype=bool)
        kill[box_b] = ~ok
        n_b = int(((alpha > 0) & kill).sum())
        alpha[kill] = 0

    print("  [hand] 左下切掉 %d px（气泡文字），右下切掉 %d px（笔记本亮块）" % (n_a, n_b))
    return alpha


def build_alpha(rgb: Image.Image) -> np.ndarray:
    """角色 alpha（0~255，float）。"""
    fg = ~flood_background(rgb)
    rgb_arr = np.asarray(rgb)

    # 1) 开运算切断「角色 → 背景残块」之间的细桥
    fg = ndimage.binary_opening(fg, structure=disk(3))

    # 2) 清扫（膨胀之前！）——只留主分量 + 1px 内相邻的小分量（兜帽侧鳍）
    lab, n = ndimage.label(fg)
    if n:
        sizes = ndimage.sum(fg, lab, range(1, n + 1))
        main = int(np.argmax(sizes)) + 1
        grown = ndimage.binary_dilation(lab == main, structure=disk(1))
        keep = np.zeros_like(fg)
        for i in range(1, n + 1):
            comp = lab == i
            if i == main or (comp & grown).any():
                keep |= comp
        fg = keep
    fg = drop_corner_scraps(fg, rgb_arr, 0.03, "pre-dilate")

    # 3) 回胀补轮廓 + 填洞 + 闭合
    fg = ndimage.binary_dilation(fg, structure=disk(4))
    fg = ndimage.binary_fill_holes(fg)
    fg = ndimage.binary_closing(fg, structure=disk(2))

    # 4) 再扫一遍（保险）
    fg = drop_corner_scraps(fg, rgb_arr, 0.02, "post-dilate")

    alpha = fg.astype(np.float32) * 255.0
    alpha = np.asarray(
        Image.fromarray(alpha.astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(1.1)),
        dtype=np.float32,
    )
    # 5) 定点清扫：气泡文字 / 笔记本亮块（必须在模糊之后、按最终坐标切）
    alpha = hand_cleanup(alpha, rgb)
    return alpha


def main():
    im = Image.open(SRC).convert("RGB")
    W, H = im.size
    l, t, r, b = CROP
    box = (int(l * W), int(t * H), int(r * W), int(b * H))
    crop = im.crop(box)
    cw, ch = crop.size
    scale = WORK_W / cw
    work = crop.resize((WORK_W, max(1, int(round(ch * scale)))), Image.LANCZOS)
    ww, wh = work.size
    print("crop(src)=%s  work=%s" % (crop.size, work.size))

    alpha = build_alpha(work)
    print("角色占画面比例: %.1f%%" % ((alpha > 128).mean() * 100))

    # 按 alpha 包围盒收紧构图（留一点边），否则桌宠在小画布里显得空
    ys, xs = np.where(alpha > 8)
    if len(xs):
        m = 10
        x0 = max(0, int(xs.min()) - m)
        x1 = min(ww, int(xs.max()) + 1 + m)
        y0 = max(0, int(ys.min()) - m)
        y1 = min(wh, int(ys.max()) + 1 + m)
    else:
        x0, y0, x1, y1 = 0, 0, ww, wh
    alpha = alpha[y0:y1, x0:x1]
    work = work.crop((x0, y0, x1, y1))
    ww, wh = work.size
    print("bbox trim -> %s (offset %d,%d)" % (work.size, x0, y0))

    # 底边羽化（避免一条硬直线）
    fy = int(wh * (1 - FEATHER_BOTTOM))
    ramp = np.clip((np.arange(wh) - fy) / max(1, (wh - 1 - fy)), 0, 1)
    alpha = alpha * (1.0 - ramp)[:, None]

    rgba = np.dstack([np.asarray(work, dtype=np.uint8), alpha.astype(np.uint8)])

    def cut_y(frac_src):
        """在裁切图内的 y 像素；要减掉 bbox 偏移。"""
        return (frac_src * H - box[1]) * scale - y0

    y_body = cut_y(CUT_BODY)
    y_head = cut_y(CUT_HEAD)

    body = rgba.copy()
    body[: int(round(y_body)), :, 3] = 0
    head = rgba.copy()
    head[int(round(y_head)):, :, 3] = 0

    img_body = Image.fromarray(body, "RGBA")
    img_head = Image.fromarray(head, "RGBA")
    img_full = Image.fromarray(rgba, "RGBA")

    for name, img in (("body.png", img_body), ("head.png", img_head), ("full.png", img_full)):
        p = os.path.join(OUT, name)
        img.save(p)
        print("wrote", p, img.size)

    # ---- 调试对照表：棋盘底 + 各层 ----
    def checker(size, sq=12):
        a = np.zeros((size[1], size[0], 3), np.uint8)
        yy, xx = np.mgrid[0:size[1], 0:size[0]]
        m = (((xx // sq) + (yy // sq)) % 2).astype(bool)
        a[...] = 226
        a[m] = 196
        return Image.fromarray(a, "RGB")

    pad = 16
    cols = 3
    sheet = Image.new("RGB", (pad * (cols + 1) + ww * cols, pad * 2 + wh + 34), (250, 250, 252))
    d = ImageDraw.Draw(sheet)
    try:
        f = ImageFont.truetype(FONT, 18)
    except Exception:
        f = ImageFont.load_default()
    for i, (label, img) in enumerate((("full 抠像", img_full), ("head 头层", img_head), ("body 身体层", img_body))):
        x = pad + i * (ww + pad)
        bgc = checker(img.size)
        bgc.paste(img, (0, 0), img)
        sheet.paste(bgc, (x, pad + 34))
        d.text((x, pad + 8), label, font=f, fill=(30, 38, 60))
    p = os.path.join(DBG, "layers-debug.png")
    sheet.save(p)
    print("wrote", p)

    # 合成验证：头层绕脖子 pivot 转 3°，看接缝会不会露洞
    pivot_src = (4.45 / 10 * W, CUT_BODY * H)
    pv = ((pivot_src[0] - box[0]) * scale - x0, (pivot_src[1] - box[1]) * scale - y0)
    rot = img_head.rotate(3.0, resample=Image.BICUBIC, center=pv, expand=False)
    comp = checker(img_full.size)
    comp.paste(img_body, (0, 0), img_body)
    comp.paste(rot, (0, 0), rot)
    comp.save(os.path.join(DBG, "seam-test.png"))
    print("wrote", os.path.join(DBG, "seam-test.png"), "pivot=", tuple(round(v, 1) for v in pv))
    return 0


if __name__ == "__main__":
    sys.exit(main())
