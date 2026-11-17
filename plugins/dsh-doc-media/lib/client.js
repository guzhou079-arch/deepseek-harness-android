/**
 * dsh-doc-media —— 文件预览里的视频播放器
 *
 * 为什么需要它：
 * 内核的 documentpreview 把 mp4 / webm / mov / m4v / mkv 都列进了
 * UNVIEWABLE_BINARY_EXTENSIONS（「已知二进制容器、没有渲染器」），
 * 所以点开视频只会看到一句「无法预览此文件」。
 *
 * 但同一个模块里的注册表写着明确规则：
 *   「any renderer registration for a suffix takes precedence because
 *     the owner consults this list only when no implementation matches.」
 * ⇒ 只要注册一个 extensions 覆盖这些后缀的 renderer，unviewable 列表就自动让路。
 *
 * 加载方式沿用内置 HTML/图片预览的 `bytes-complete`：宿主把整个文件读成
 * Uint8Array 交给 body，这里转成 Blob URL 丢给 <video>。短视频（几十 MB）
 * 毫无问题；超过 MAX_BYTES 会明确提示「文件过大」，而不是假装在播。
 *
 * 注意：mkv 这类容器不一定每个 WebView 都带解码器，播不动时页面会给出
 * 兜底提示，不会白屏。
 */
window.__ModuleLoader__.load({
  id: 'dsh-doc-media',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** 本注册项在 registry / slot 里的唯一 id（两处必须一致）。 */
    const BODY_ID = '@local/dsh-doc-media/video';

    /** 浏览器能直接解码的容器 → MIME。 */
    const VIDEO_TYPES = {
      mp4: 'video/mp4',
      m4v: 'video/x-m4v',
      webm: 'video/webm',
      mov: 'video/quicktime',
      mkv: 'video/x-matroska',
      ogv: 'video/ogg',
    };

    const EXTENSIONS = Object.keys(VIDEO_TYPES);

    /** 超过这个体积就别塞进 WebView 内存了（Blob + 解码会翻倍）。 */
    const MAX_BYTES = 200 * 1024 * 1024;

    const NS = 'dsh-doc-media';
    /** 键集与 en 一一对应；缺词时 t() 回落成 key，不会抛。 */
    const zh = {
      waiting: '视频预览需要完整文件内容。',
      tooLarge: '这个视频有 {size}，超过预览上限（{max}）。',
      tooLargeHint: '用「显示文件位置」拿到原文件，交给系统播放器更合适。',
      failed: '无法播放：{error}',
      preparing: '准备播放…',
      video: '视频',
      codecHint: '黑屏或没声音，多半是 WebView 解不了这个容器；换 mp4 或交给系统播放器。',
      fullscreenHint: '手机上长按画面可全屏。',
    }
    const en = {
      waiting: 'Video preview requires the complete file contents.',
      tooLarge: 'This video is {size}, above the {max} preview limit.',
      tooLargeHint: 'Use "Show file location" to get the original file and open it in a system player.',
      failed: 'Cannot play: {error}',
      preparing: 'Preparing…',
      video: 'Video',
      codecHint: 'A black screen or no audio usually means WebView cannot decode this container. Try mp4 or a system player.',
      fullscreenHint: 'Long-press the frame on a phone to go fullscreen.',
    }
    /** apply() 里换成 ctx.locale.bind(NS)。 */
    let T = (key, params) => {
      const template = zh[key] === undefined ? key : zh[key];
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
    };

    /**
     * 从 `dsh-resource://file/session/<id>/<path>` 里取文件名与后缀。
     * 不依赖内核内部的 parseFileAddress，只按最后一段解析，够用且不会跨模块引用。
     */
    function fileOf(address) {
      let raw = String(address === undefined || address === null ? '' : address);
      const cut = raw.search(/[?#]/);
      if (cut >= 0) raw = raw.slice(0, cut);
      const segments = raw.split('/');
      let encoded = segments.length > 0 ? segments[segments.length - 1] : '';
      let name = encoded;
      try {
        name = decodeURIComponent(encoded);
      } catch {
        // 编码坏了就保留原样，别因此整块不渲染。
      }
      const dot = name.lastIndexOf('.');
      return {
        name,
        suffix: dot < 0 ? '' : name.slice(dot + 1).toLowerCase(),
      };
    }

    /** 人类可读的体积。 */
    function humanSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    const styles = {
      frame: {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minHeight: '100%',
        padding: '10px 12px 14px',
      },
      meta: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        minWidth: 0,
        color: 'var(--dsw-alias-text-secondary, #9aa0a6)',
        fontSize: '12px',
      },
      name: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-text-primary, #e6edf3)',
        fontWeight: 600,
      },
      video: {
        display: 'block',
        width: '100%',
        maxHeight: '72vh',
        background: '#000',
        borderRadius: '10px',
        outline: 'none',
      },
      note: {
        margin: 0,
        color: 'var(--dsw-alias-text-secondary, #9aa0a6)',
        fontSize: '12px',
        lineHeight: 1.5,
      },
      alert: {
        margin: 0,
        padding: '10px 12px',
        borderRadius: '10px',
        background: 'rgba(255, 255, 255, 0.04)',
        color: 'var(--dsw-alias-text-primary, #e6edf3)',
        fontSize: '13px',
        lineHeight: 1.6,
      },
    };

    /**
     * 文档预览的视频 body。
     * props 由宿主拼好：resourceAddress / content / wrap / scrollportRef / addResource / setResources。
     */
    function VideoBody(props) {
      const content = props === undefined ? undefined : props.content;
      const data = content !== undefined && content !== null && content.kind === 'bytes' ? content.data : undefined;
      const info = fileOf(props === undefined ? '' : props.resourceAddress);
      const mime = VIDEO_TYPES[info.suffix] || 'video/mp4';

      const [url, setUrl] = React.useState(undefined);
      const [failure, setFailure] = React.useState(undefined);

      React.useEffect(() => {
        if (data === undefined) {
          setUrl(undefined);
          return undefined;
        }
        if (data.byteLength > MAX_BYTES) {
          setUrl(undefined);
          return undefined;
        }
        let objectUrl;
        try {
          objectUrl = URL.createObjectURL(new Blob([data], { type: mime }));
          setUrl(objectUrl);
          setFailure(undefined);
        } catch (error) {
          setFailure(String(error && error.message ? error.message : error));
        }
        return () => {
          if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
        };
      }, [data, mime]);

      if (data === undefined) {
        return h('p', { style: styles.alert, 'data-doc-media': 'waiting' }, T('waiting'));
      }
      if (data.byteLength > MAX_BYTES) {
        return h(
          'div',
          { style: styles.frame, 'data-doc-media': 'too-large' },
          h('p', { style: styles.alert }, T('tooLarge', { size: humanSize(data.byteLength), max: humanSize(MAX_BYTES) })),
          h('p', { style: styles.note }, T('tooLargeHint')),
        );
      }
      if (failure !== undefined) {
        return h('p', { style: styles.alert, 'data-doc-media': 'failed' }, T('failed', { error: failure }));
      }
      if (url === undefined) {
        return h('p', { style: styles.note, 'data-doc-media': 'preparing' }, T('preparing'));
      }

      return h(
        'div',
        { style: styles.frame, 'data-doc-media': 'video' },
        h(
          'div',
          { style: styles.meta },
          h('span', { style: styles.name, title: info.name }, info.name || T('video')),
          h('span', null, humanSize(data.byteLength)),
        ),
        h('video', {
          src: url,
          controls: true,
          playsInline: true,
          preload: 'metadata',
          style: styles.video,
          'data-doc-media-player': info.suffix,
        }),
        h(
          'p',
          { style: styles.note },
          info.suffix === 'mkv' || info.suffix === 'mov' || info.suffix === 'ogv'
            ? T('codecHint')
            : T('fullscreenHint'),
        ),
      );
    }

    /**
     * 客户端插件入口：注册元数据（决定哪些后缀归这个渲染器）与 keyed body。
     * 两者必须用同一个 id，否则 owner 会显示「renderer unavailable」。
     */
    function apply(ctx) {
      T = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'doc-media: zh');
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'doc-media: en');
      ctx.effect(() =>
        ctx.documentPreviews.register({
          id: BODY_ID,
          extensions: EXTENSIONS,
          priority: 'builtin',
          title: () => T('video'),
          loading: 'bytes-complete',
          wrap: false,
        }),
      'doc-media: preview metadata');

      ctx.effect(() =>
        ctx.slots.inject('sidebar.right.tab.document', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.tab.document',
              key: BODY_ID,
            },
            VideoBody,
          ),
        ),
      'doc-media: preview body');
    }

    exports.VideoBody = VideoBody;
    exports.fileOf = fileOf;
    exports.BODY_ID = BODY_ID;
    exports.apply = apply;
    exports.inject = ['documentPreviews', 'slots', 'locale'];
    return module.exports;
  },
});
