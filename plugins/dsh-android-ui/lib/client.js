/**
 * dsh-android-ui —— 客户端半边（自定义背景图）
 *
 * 这一段原先住在 @deepseek-ai/dsh-client-ui-open-in-app/lib/client.js 的 factory 顶部
 * （往那个文件里塞了一个 <link href="/dsh-bg.css"> 的注入）。现在搬进本插件：
 *   · CSS **内联在这里**，不再需要 dist/dsh-bg.css
 *   · 注入由插件自己做，不再需要改上游的 open-in-app
 *   · 插件住在 dshhome/profiles/... → 内核升级不会覆盖它，也不会遮蔽上游代码
 *
 * 图片仍走已在服务的 /dsh-bg-user.png（受 v1.24 门禁保护：需 cookie；页面本身已认证，故正常）。
 * 想换图：改下面 --dsh-user-bg-image 的 url，或在 :root 里覆盖。
 *
 * ⚠ 哈希类名坑（2026-09-29 rc.2 事故「问题 4」）：
 *   上游 CSS Modules 的类名带构建哈希（`ZTP-Xa_frame` → rc.2 变成 `pI_x6G_frame`），
 *   写死的选择器一升内核就全失效——症状正是「主页没壁纸，点开侧边栏壁纸又出来了」。
 *   所以类名**不再写死在 CSS 里**，集中在下面 @dsh-bg-classes 区块，由
 *   `selfbuild/scripts/sync-bg-plugin-classes.js` 按当前内核**逐代累积**生成；
 *   换内核后跑一次那个脚本即可（两代类名同时保留 → rc.1/rc.2 都能显示）。
 *
 * 纪律：纯展示型；节点由 ctx.effect 回收；重复激活时先移除旧节点（幂等）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-android-ui',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var STYLE_ID = 'dsh-user-bg-style';

    // @dsh-bg-classes:begin —— 由 selfbuild/scripts/sync-bg-plugin-classes.js 生成（逐代累积），勿手改
    // frame：@deepseek-ai/dsh-client-ui-layout 的 AppFrame.module.css 里的 "frame" 类
    // conv ：@deepseek-ai/dsh-client-ui-conversation 的 ConversationRoot.module.css 前缀
    //        （root / embeddedBody / composerSeat / data-empty-state 全部由它派生）
    var BG_FRAMES = ['.ZTP-Xa_frame', '.pI_x6G_frame'];
    var BG_CONV_PREFIXES = ['.D_tfqW', '.wSkVaW'];
    // @dsh-bg-classes:end

    /** 由类名清单派生各条规则的选择器（新增一代只需往上面的数组里加名字）。 */
    function selectors(frames, prefixes) {
      var join = (a) => a.join(', ');
      var root = prefixes.map((p) => p + '_root');
      var embedded = prefixes.map((p) => p + '_embeddedBody');
      return {
        frame: join(frames),
        convBody: join(root.concat(embedded)),
        convSeat: join(prefixes.map((p) =>
          p + '_root[data-phase="active"] ' + p + '_composerSeat, ' +
          p + '_embeddedBody[data-content-phase="active"] ' + p + '_composerSeat')),
        convEmpty: join(prefixes.map((p) => p + '_root [data-empty-state]')),
      };
    }

    var SEL = selectors(BG_FRAMES, BG_CONV_PREFIXES);

    var CSS = `
:root {
  /* 背景图：默认用用户那张插画（1254²，1.4MB）。?v= 是缓存版本号，换图就 +1。 */
  --dsh-user-bg-image: url("/dsh-bg-user.png?v=2");
  /* 遮罩：图偏亮，深色主题下需压暗才保证正文可读。 */
  --dsh-user-bg-scrim-top: rgba(4, 8, 16, 0.60);
  --dsh-user-bg-scrim-bottom: rgba(4, 8, 16, 0.76);
  /* 模糊（CSS px）：0 = 原图清晰；1~3 更易读，像壁纸 */
  --dsh-user-bg-blur: 0px;
}

/* 全窗口铺图：图与遮罩都放在 AppFrame 根容器的 ::before 里。
   ::before 绝对定位、z-index:-1 → 画在容器背景之上、所有内容之下，正文不受模糊影响。
   ⚠ 不要同时给根容器自己也铺一份：::before 是半透明的，两层叠加会灰蒙蒙。 */
${SEL.frame} {
  background: transparent !important;
}
${SEL.frame}::before {
  content: "";
  position: absolute;
  inset: -10px;
  background-image:
    linear-gradient(180deg, var(--dsh-user-bg-scrim-top), var(--dsh-user-bg-scrim-bottom)),
    var(--dsh-user-bg-image);
  background-size: cover, cover;
  background-position: center center, center center;
  background-repeat: no-repeat, no-repeat;
  filter: blur(var(--dsh-user-bg-blur));
  z-index: -1;
  pointer-events: none;
}

/* 会话列透明，让图透出来 */
${SEL.convBody} {
  background: transparent !important;
}

/* 输入栏底部渐隐别糊成一条实色，否则图在底部被切断 */
${SEL.convSeat} {
  background: linear-gradient(180deg,
    transparent 0px,
    color-mix(in srgb, var(--dsw-alias-bg-base, #0b0f1a) 84%, transparent) 36px) !important;
}

/* 空会话/新会话页的卡片别整块盖住图 */
${SEL.convEmpty} {
  background: transparent !important;
}
`;

    /** 幂等注入：已有旧节点先摘掉，避免重复激活叠加两层。 */
    function installStyle(doc) {
      var old = doc.getElementById(STYLE_ID);
      if (old && old.parentNode) old.parentNode.removeChild(old);
      var el = doc.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      (doc.head || doc.documentElement).appendChild(el);
      return el;
    }

    exports.apply = function apply(ctx) {
      ctx.effect(() => {
        const el = installStyle(document);
        return () => {
          if (el && el.parentNode) el.parentNode.removeChild(el);
        };
      });
    };

    return module.exports;
  }
});
