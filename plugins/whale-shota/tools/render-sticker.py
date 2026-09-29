#!/usr/bin/env python3
"""whale-shota 贴画版预览。

与 lib/client.js 里 CSS 的 background-size/position 用同一套裁切数学：
  源图 1254²，裁切区域 left=CROP_X top=CROP_Y side=CROP_SIDE（比例）
  → background-size = d / CROP_SIDE ；background-position = -(CROP_X|Y) / CROP_SIDE * d
换裁切时改 client.js 顶部三个系数 + 这里的三个常量。
"""
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "assets", "whale-shota.png")
OUT = os.path.join(ROOT, "preview")
os.makedirs(OUT, exist_ok=True)

CROP_X, CROP_Y, CROP_SIDE = 0.100, 0.005, 0.620
ACCENT = (84, 132, 204)          # #5484cc
FONT = "/system/fonts/NotoSansCJK-Regular.ttc"


def font(size):
    return ImageFont.truetype(FONT, size) if os.path.exists(FONT) else ImageFont.load_default()


def sticker(d, src=None):
    """按 CSS 算法裁出 d×d 圆形贴纸。"""
    im = Image.open(src or SRC).convert("RGB")
    full = max(1, round(d / CROP_SIDE))
    scaled = im.resize((full, full), Image.LANCZOS)
    x0, y0 = round(CROP_X * full), round(CROP_Y * full)
    face = scaled.crop((x0, y0, x0 + d, y0 + d))

    out = Image.new("RGBA", (d, d), (0, 0, 0, 0))
    mask = Image.new("L", (d, d), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, d - 1, d - 1], fill=255)
    out.paste(face.convert("RGBA"), (0, 0), mask)
    ring = max(1, round(d * 3 / 64))
    ImageDraw.Draw(out).ellipse([ring, ring, d - 1 - ring, d - 1 - ring],
                                outline=(255, 255, 255, 71), width=max(1, ring // 2))
    return out


def strip(path):
    """真实尺寸对照：56 / 64 / 76 px（client.js 的 clamp 区间）在亮暗底下。"""
    sizes = (56, 64, 76)
    W, H = 560, 190
    img = Image.new("RGB", (W, H), (244, 246, 251))
    d = ImageDraw.Draw(img)
    x = 34
    for s in sizes:
        a = sticker(s)
        img.paste(Image.new("RGB", (s, s), (255, 255, 255)), (x, 76))
        img.paste(a, (x, 76), a)
        d.text((x, 50), "%dpx 亮底" % s, font=font(15), fill=(26, 34, 56))
        img.paste(Image.new("RGB", (s, s), (11, 15, 26)), (x + 104, 76))
        img.paste(a, (x + 104, 76), a)
        d.text((x + 104, 50), "暗底", font=font(15), fill=(26, 34, 56))
        x += s + 148
    img.save(path)
    return path


def card(dark, text, path):
    """一帧真实观感：气泡在上、贴纸在下，右对齐（与 CSS flex column 一致）。"""
    W, H = 720, 380
    bg = (11, 15, 26) if dark else (244, 246, 251)
    fg = (232, 240, 255) if dark else (26, 34, 56)
    img = Image.new("RGBA", (W, H), bg + (255,))
    d = ImageDraw.Draw(img)

    size = 76
    bx_right = W - 16
    by_bottom = H - 14
    btn_x = bx_right - size
    btn_y = by_bottom - size

    bw, bh = 300, 62
    bx, by = bx_right - bw, btn_y - 8 - bh
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=12,
                        fill=(9, 16, 34) if dark else (255, 255, 255), outline=ACCENT, width=2)
    d.text((bx + 18, by + 14), text, font=font(28), fill=fg)

    img.alpha_composite(sticker(size), (btn_x, btn_y))

    d.text((40, 40), "whale-shota", font=font(30), fill=fg)
    d.text((40, 84), "傲娇鲸鱼正太 · 圆贴纸桌宠", font=font(18), fill=fg)
    d.text((40, H - 46), "哼！ / 你们还不懂… / 其实我早就想到了… / 我超聪明的！", font=font(17), fill=fg)
    img.convert("RGB").save(path, quality=92)
    return path


if __name__ == "__main__":
    print("wrote", strip(os.path.join(OUT, "sticker-sizes.png")))
    print("wrote", card(False, "我超聪明的！", os.path.join(OUT, "light.webp")))
    print("wrote", card(True, "其实我早就想到了…", os.path.join(OUT, "dark.webp")))
    sticker(320).save(os.path.join(OUT, "sticker.png"))
    print("wrote sticker.png")
