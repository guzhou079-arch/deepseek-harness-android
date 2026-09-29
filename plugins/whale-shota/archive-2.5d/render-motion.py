#!/usr/bin/env python3
"""whale-shota 2.5D 动效合成与预览。

把 layers/head.png + layers/body.png 按「呼吸 + 歪头」的变换合成，
导出：
  preview/motion-strip.png    关键帧对照（暗底 + 亮底）
  preview/motion.webp         动图（真实循环）
变换参数与 lib/client.js 里的常量一一对应，改一边记得改另一边。
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LAYERS = os.path.join(ROOT, "layers")
OUT = os.path.join(ROOT, "preview")
os.makedirs(OUT, exist_ok=True)

# ---- 动效常量（与 client.js 对齐）--------------------------------------
PIVOT = (225.3, 319.0)      # 脖子转轴（图层像素坐标）
DISP_W = 240                # 桌宠显示宽度
PERIOD = 3.2                # 呼吸周期（秒）
HEAD_DEG = 1.7              # 歪头幅度（度）
HEAD_LAG = 0.35             # 头相对身体的相位滞后（弧度）
BREATH_PX = 1.8             # 呼吸位移（图层像素）
BREATH_SCALE = 0.004        # 身体纵向缩放幅度
SWAY_PX = 0.9               # 头部横向微摆
SWAY_PERIOD = 4.3

FONT = "/system/fonts/NotoSansCJK-Regular.ttc"


def affine(img, theta_deg, scale_y, tx, ty, pivot):
    """绕 pivot 旋转 + 纵向缩放 + 平移，一次性做完（等价 CSS transform）。"""
    th = math.radians(theta_deg)
    cos_t, sin_t = math.cos(th), math.sin(th)
    px, py = pivot
    # 先绕 pivot 缩放 y（肩膀不动的感觉），再旋转，再平移
    a, b = cos_t, -sin_t
    d, e = sin_t, cos_t
    c = px - cos_t * px + sin_t * py + tx
    f = py - sin_t * px - cos_t * py + ty
    # 叠加纵向缩放：绕 pivot 的 y 缩放
    e2 = e * scale_y
    f2 = f + py * (1 - scale_y)
    return img.transform(img.size, Image.AFFINE, (a, b, c, d, e2, f2),
                         resample=Image.BICUBIC)


def frame(t, dark=True, disp_w=DISP_W):
    """按时刻 t（秒）合成一帧（RGBA）。"""
    head = Image.open(os.path.join(LAYERS, "head.png")).convert("RGBA")
    body = Image.open(os.path.join(LAYERS, "body.png")).convert("RGBA")

    w, h = head.size
    s = disp_w / w

    phase = 2 * math.pi * t / PERIOD
    breath = math.sin(phase)
    sway = math.sin(2 * math.pi * t / SWAY_PERIOD)

    ty = BREATH_PX * breath
    head_theta = HEAD_DEG * math.sin(phase - HEAD_LAG)
    head_tx = SWAY_PX * sway

    b = affine(body, 0.0, 1.0 + BREATH_SCALE * breath, 0.0, ty, PIVOT)
    hd = affine(head, head_theta, 1.0 + BREATH_SCALE * breath, head_tx, ty, PIVOT)

    # 缩放前把画布对齐到 pivot 附近的整体内容，再统一降到显示尺寸
    base = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    base.alpha_composite(b)
    base.alpha_composite(hd)
    base = base.resize((disp_w, max(1, round(h * s))), Image.LANCZOS)

    bg = Image.new("RGB", base.size, (11, 15, 26) if dark else (244, 246, 251))
    bg.paste(base, (0, 0), base)
    return bg


def main():
    # 关键帧条：t = 0, 0.4, 0.8, 1.2, 1.6（覆盖一个呼吸周期的正负峰）
    ts = [0.0, 0.4, 0.8, 1.2, 1.6]
    tiles = [frame(t, dark=True) for t in ts]
    tw, th = tiles[0].size
    pad = 10
    W = pad * (len(tiles) + 1) + tw * len(tiles)
    H = pad * 2 + th * 2 + 60
    sheet = Image.new("RGB", (W, H), (250, 250, 252))
    d = ImageDraw.Draw(sheet)
    try:
        f = ImageFont.truetype(FONT, 16)
    except Exception:
        f = ImageFont.load_default()
    d.text((pad, 8), "暗色主题 · 一个呼吸周期的 5 个关键帧", font=f, fill=(30, 38, 60))
    for i, tile in enumerate(tiles):
        sheet.paste(tile, (pad + i * (tw + pad), 34))
    y2 = 34 + th + 30
    d.text((pad, y2 - 22), "亮色主题", font=f, fill=(30, 38, 60))
    for i, t in enumerate(ts):
        sheet.paste(frame(t, dark=False), (pad + i * (tw + pad), y2))
    sheet.save(os.path.join(OUT, "motion-strip.png"))
    print("wrote motion-strip.png", sheet.size)

    frames = [frame(t / 12.0, dark=True) for t in range(int(PERIOD * 12))]
    frames[0].save(os.path.join(OUT, "motion.webp"), save_all=True,
                   append_images=frames[1:], duration=int(1000 / 12), loop=0, quality=88)
    print("wrote motion.webp", len(frames), "frames")

    # skin.json 约定的亮/暗预览图（用整只桌宠，不再是最早的圆头像）
    for dark, name in ((False, "light.webp"), (True, "dark.webp")):
        f = frame(0.8, dark=dark, disp_w=380)
        f.save(os.path.join(OUT, name), quality=90)
        print("wrote", name, f.size)


if __name__ == "__main__":
    main()
