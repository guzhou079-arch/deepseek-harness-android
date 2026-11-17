// dsh-user-profile —— 面板页面（服务端直出 HTML，无构建、无外部依赖、离线可用）
//
// v4 · 「点开再选」：所有选项从原生 select / 刻度轨道，统一改成
//   一行标签 + 右侧胶囊按钮（像模型选择器），点开从底部升起一张磨砂玻璃抽屉。
// - 抽屉：backdrop-filter 磨砂 + 顶部高光 + 把手 + 遮罩，点遮罩/选项/Esc 关闭。
// - 页面骨架沿用 v3：打标题、留白分层、成段文字共用左侧竖线、单行输入底线。
// - 保留 v3 修掉的那个坑：轨道类元素不再用写死的 top（v3 已删刻度，此处为约束备忘）。
// 刻意不用：原生 select 弹窗、分组卡片、分隔行、右对齐裸值、emoji 图标。

export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>用户设定</title>
<style>
  :root{
    --bg:#0e0e10; --tx:#ececee; --tx2:#b2b2b9; --dim:#86868e; --faint:#55555c;
    --line:rgba(255,255,255,.14); --line-soft:rgba(255,255,255,.06);
    --field:rgba(255,255,255,.07); --sheet:rgba(24,24,28,.72);
    --sheet-hi:rgba(255,255,255,.07);
    --acc:#8399ff; --acc-ring:rgba(131,153,255,.22);
    --on-acc:#0c0e1c; --err:#f08b6f; --safe:env(safe-area-inset-bottom,0px);
    --ease:cubic-bezier(.2,.7,.3,1); --sheet-ease:cubic-bezier(.22,.9,.28,1);
  }
  @media (prefers-color-scheme:light){
    :root{
      --bg:#f8f8f6; --tx:#17171a; --tx2:#46464d; --dim:#75757d; --faint:#a9a9b0;
      --line:rgba(0,0,0,.14); --line-soft:rgba(0,0,0,.07);
      --field:rgba(0,0,0,.05); --sheet:rgba(255,255,255,.74);
      --sheet-hi:rgba(255,255,255,.85);
      --acc:#3a5bdc; --acc-ring:rgba(58,91,220,.15);
      --on-acc:#fff; --err:#c2462b;
    }
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;padding:0}
  body{
    background:var(--bg); color:var(--tx);
    font:16px/1.7 system-ui,-apple-system,"PingFang SC","HarmonyOS Sans SC","MiSans","Noto Sans CJK SC","Source Han Sans SC",sans-serif;
    padding:40px 22px calc(112px + var(--safe)); max-width:600px; margin:0 auto;
    -webkit-font-smoothing:antialiased; line-break:strict; text-autospace:normal;
  }
  header{margin-bottom:48px}
  h1{margin:0 0 10px; font-size:28px; line-height:1.3; font-weight:650}
  .lede{margin:0; font-size:15px; line-height:1.75; color:var(--dim)}

  section + section{margin-top:56px}
  h2{margin:0 0 24px; font-size:18px; line-height:1.4; font-weight:600}
  .sub{margin:-16px 0 22px; font-size:14px; line-height:1.7; color:var(--dim)}

  .field{margin-bottom:32px}
  .field:last-child{margin-bottom:0}
  .field > label{display:block; margin-bottom:4px; font-size:14px; font-weight:500; color:var(--tx2)}
  .meta{display:flex; justify-content:space-between; align-items:baseline; gap:16px;
    margin-top:8px; font-size:13px; line-height:1.6; color:var(--dim)}
  .count{flex:none; color:var(--faint); font-variant-numeric:tabular-nums; transition:color .16s ease}
  .count.near{color:var(--err)}

  input[type=text]{
    display:block; width:100%; font:inherit; font-size:20px; font-weight:500; color:var(--tx);
    background:transparent no-repeat 0 100%/0 2px;
    background-image:linear-gradient(var(--acc),var(--acc)); background-origin:border-box;
    border:0; border-bottom:1px solid var(--line); border-radius:0;
    padding:8px 0 10px; outline:0;
    transition:background-size .18s var(--ease);
  }
  input[type=text]:focus{background-size:100% 2px}
  ::placeholder{color:var(--faint); opacity:1}

  .rail{border-left:2px solid var(--line); padding-left:16px; transition:border-color .16s ease}
  .rail:focus-within{border-left-color:var(--acc)}
  textarea{
    display:block; width:100%; font:inherit; font-size:16px; line-height:1.8; color:var(--tx);
    background:transparent; border:0; border-radius:0; outline:0; padding:2px 0;
    min-height:116px; max-height:208px; resize:none; overflow-y:auto;
  }

  /* ── 选项行：左标签 + 右胶囊（像模型选择器） ── */
  .opts-list{margin-top:8px}
  .row{display:flex; align-items:center; justify-content:space-between; gap:14px;
    padding:13px 0; border-bottom:1px solid var(--line-soft)}
  .row:last-child{border-bottom:0}
  .row .lab{font-size:15px; color:var(--tx2); min-width:0}
  .pill{
    flex:none; display:inline-flex; align-items:center; gap:9px;
    font:inherit; font-size:15px; font-weight:500; color:var(--tx);
    background:var(--field); border:0; border-radius:999px;
    padding:8px 13px 8px 15px; cursor:pointer;
    transition:background-color .16s ease, transform .12s var(--ease);
  }
  .pill:active{transform:scale(.965)}
  .pill:focus-visible{outline:2px solid var(--acc-ring); outline-offset:2px}
  .pill .chev{width:8px; height:8px; margin-top:-3px; flex:none;
    border-right:1.6px solid var(--dim); border-bottom:1.6px solid var(--dim);
    transform:rotate(45deg); transition:border-color .16s ease}
  .pill:active .chev{border-color:var(--tx2)}
  .pill .v{white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:11em}

  /* ── 遮罩 ── */
  .scrim{
    position:fixed; inset:0; z-index:40;
    background:rgba(0,0,0,.45);
    opacity:0; pointer-events:none;
    transition:opacity .24s var(--ease);
    -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px);
  }
  .scrim.on{opacity:1; pointer-events:auto}

  /* ── 抽屉：磨砂玻璃 ── */
  .sheet{
    position:fixed; left:0; right:0; bottom:0; z-index:41;
    padding:0 18px calc(14px + var(--safe));
    border-radius:24px 24px 0 0;
    background-color:var(--sheet);
    background-image:linear-gradient(180deg,var(--sheet-hi),rgba(255,255,255,0) 46%);
    -webkit-backdrop-filter:blur(30px) saturate(1.7);
    backdrop-filter:blur(30px) saturate(1.7);
    border-top:1px solid var(--line);
    box-shadow:0 -18px 60px rgba(0,0,0,.34);
    transform:translateY(102%);
    transition:transform .3s var(--sheet-ease);
    max-height:82vh; overflow:auto; overscroll-behavior:contain;
    max-width:600px; margin:0 auto;
  }
  .sheet.on{transform:translateY(0)}
  .grab{width:36px; height:4px; border-radius:2px; background:var(--line);
    margin:10px auto 4px}
  .sheet h3{margin:6px 0 4px; font-size:15px; font-weight:600; color:var(--tx2);
    text-align:center; letter-spacing:0}
  .opt{
    display:flex; align-items:center; justify-content:space-between; gap:16px;
    width:100%; font:inherit; font-size:16px; line-height:1.5; text-align:left; color:var(--tx);
    background:transparent; border:0; border-radius:12px;
    padding:14px 12px; margin:2px 0; cursor:pointer;
    transition:background-color .14s ease;
  }
  .opt:active{background:var(--field)}
  .opt .tick{width:17px; height:17px; flex:none; opacity:0;
    transition:opacity .14s ease}
  .opt[aria-selected=true]{color:var(--acc); font-weight:600}
  .opt[aria-selected=true] .tick{opacity:1}
  .opt:focus-visible{outline:2px solid var(--acc-ring); outline-offset:-2px}

  /* ── 预览 ── */
  pre{margin:0; white-space:pre-wrap; word-break:break-word;
    font:inherit; font-size:15px; line-height:1.8; color:var(--tx2)}

  /* ── 错误 ── */
  .err{border-left:2px solid var(--err); padding:3px 0 3px 16px; margin-bottom:30px;
    font-size:14px; line-height:1.65; color:var(--err); word-break:break-word}

  /* ── 保存 ── */
  .bar{
    position:fixed; left:0; right:0; bottom:0; z-index:30;
    padding:12px 22px calc(12px + var(--safe));
    background:var(--bg);
  }
  .bar::before{content:""; position:absolute; left:0; right:0; bottom:100%; height:28px;
    background:linear-gradient(to top,var(--bg),rgba(0,0,0,0)); pointer-events:none}
  .bar button{
    display:block; width:100%; max-width:556px; margin:0 auto;
    font:inherit; font-size:16px; font-weight:600; letter-spacing:0;
    color:var(--bg); background:var(--tx); border:0; border-radius:12px;
    padding:15px; cursor:pointer;
    transition:opacity .16s ease,transform .12s var(--ease),background-color .16s ease,color .16s ease;
  }
  .bar button:active{transform:scale(.98); opacity:.86}
  .bar button[disabled]{opacity:.5}
  .bar button.done{background:var(--acc); color:var(--on-acc)}

  @media (prefers-reduced-motion:reduce){
    *{transition-duration:.01ms !important}
  }
</style>
</head>
<body>

<header>
  <h1>用户设定</h1>
  <p class="lede">你怎么被称呼，以及它该怎么认识你、怎么跟你说话。改完保存，下一条消息生效。</p>
</header>

<div id="err"></div>

<section>
  <h2>关于你</h2>

  <div class="field">
    <label for="nickname">称呼</label>
    <input type="text" id="nickname" placeholder="怎么称呼你" autocomplete="off" autocapitalize="off" spellcheck="false">
  </div>

  <div class="field">
    <label for="aboutMe">它该知道的事</label>
    <div class="rail">
      <textarea id="aboutMe" maxlength="500" placeholder="在做什么、常遇到什么、不喜欢被怎么说话……&#10;比如：这个 App 是我自己在手机上编译维护的，别给我绕远路的方案。"></textarea>
    </div>
    <div class="meta">
      <span>写具体的事，比写形容词有用。</span>
      <span class="count" id="count">0 / 500</span>
    </div>
  </div>
</section>

<section>
  <h2>说话方式</h2>
  <div class="opts-list">
    <div class="row">
      <span class="lab">基础风格</span>
      <button class="pill" id="style" data-key="style" data-v="friendly"><span class="v">亲和友善</span><i class="chev"></i></button>
    </div>
    <div class="row">
      <span class="lab">亲切程度</span>
      <button class="pill" data-key="warmth" data-v="high"><span class="v">增强</span><i class="chev"></i></button>
    </div>
    <div class="row">
      <span class="lab">热情程度</span>
      <button class="pill" data-key="energy" data-v="high"><span class="v">增强</span><i class="chev"></i></button>
    </div>
    <div class="row">
      <span class="lab">主动程度</span>
      <button class="pill" data-key="proactive" data-v="default"><span class="v">有必要才补</span><i class="chev"></i></button>
    </div>
    <div class="row">
      <span class="lab">表情符号</span>
      <button class="pill" data-key="emoji" data-v="high"><span class="v">增强</span><i class="chev"></i></button>
    </div>
  </div>
</section>

<section>
  <h2>它会读到的话</h2>
  <p class="sub">下面这段会原样写进提示词，所见即所注入。</p>
  <div class="rail"><pre id="preview"></pre></div>
</section>

<div class="bar"><button id="save">保存</button></div>

<div class="scrim" id="scrim"></div>
<div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
  <div class="grab"></div>
  <h3 id="sheetTitle"></h3>
  <div id="opts"></div>
</div>

<script>
(function(){
  var LANG=(navigator.language||'zh').toLowerCase().indexOf('zh')===0?'zh':'en';
  var I18N={zh:{},en:{"亲和友善，温和健谈": "Friendly, warm and talkative", "专业可靠，精确克制": "Professional, precise and restrained", "直言不讳，直率乐观": "Blunt, direct and optimistic", "天马行空，有趣味": "Imaginative and playful", "高效务实，简练直白": "Efficient, practical and concise", "吐槽达人，犀利但有分寸": "Sharp-tongued but tasteful", "偏低": "Low", "默认": "Default", "偏高": "High", "答完就停，不追加建议": "Stop after answering, no extra suggestions", "有必要时才补一句": "Add a line only when needed", "答完给判断或下一步，主动递出": "Give a verdict or next step, offer it proactively", "尽量不用": "Avoid when possible", "偶尔，不刻意": "Occasionally, not forced", "偶尔一个，放句尾": "One now and then, at the end", "基础风格": "Base style", "亲和友善 · 温和健谈": "Friendly · warm and talkative", "专业可靠 · 精确克制": "Professional · precise and restrained", "直言不讳 · 直率乐观": "Blunt · direct and optimistic", "天马行空 · 有趣味": "Imaginative · playful", "高效务实 · 简练直白": "Efficient · concise", "吐槽达人 · 犀利有分寸": "Sharp-tongued · tasteful", "亲切程度": "Closeness", "减弱": "Less", "增强": "More", "热情程度": "Enthusiasm", "主动程度": "Initiative", "答完就停": "Stop after", "有必要才补": "Only if needed", "主动递一句": "Offer a line", "表情符号": "Emoji", "亲和友善": "Friendly", "专业可靠": "Professional", "直言不讳": "Blunt", "天马行空": "Imaginative", "高效务实": "Efficient", "吐槽达人": "Sharp", "读取失败：": "Read failed: ", "（当前是默认值，保存会覆盖）": " (currently the default; saving overwrites it)", "连不上引擎：": "Cannot reach the engine: ", "保存中…": "Saving…", "保存被拒": "Save rejected", "已保存": "Saved", "保存": "Save", "保存失败：": "Save failed: "}};
  function t(k){var d=I18N[LANG]||{};return d[k]!==undefined?d[k]:k;}
  var API='/user-profile/api/profile';
  var F={nickname:'',aboutMe:'',style:'friendly',warmth:'high',energy:'high',proactive:'default',emoji:'high'};
  var STYLE={friendly:t("亲和友善，温和健谈"),professional:t("专业可靠，精确克制"),direct:t("直言不讳，直率乐观"),playful:t("天马行空，有趣味"),efficient:t("高效务实，简练直白"),sharp:t("吐槽达人，犀利但有分寸")};
  var LVL={low:t("偏低"),default:t("默认"),high:t("偏高")};
  var PROACTIVE={low:t("答完就停，不追加建议"),default:t("有必要时才补一句"),high:t("答完给判断或下一步，主动递出")};
  var EMOJI={low:t("尽量不用"),default:t("偶尔，不刻意"),high:t("偶尔一个，放句尾")};

  var FIELDS={
    style:{title:t("基础风格"),opts:[['friendly',t("亲和友善 · 温和健谈")],['professional',t("专业可靠 · 精确克制")],['direct',t("直言不讳 · 直率乐观")],['playful',t("天马行空 · 有趣味")],['efficient',t("高效务实 · 简练直白")],['sharp',t("吐槽达人 · 犀利有分寸")]]},
    warmth:{title:t("亲切程度"),opts:[['low',t("减弱")],['default',t("默认")],['high',t("增强")]]},
    energy:{title:t("热情程度"),opts:[['low',t("减弱")],['default',t("默认")],['high',t("增强")]]},
    proactive:{title:t("主动程度"),opts:[['low',t("答完就停")],['default',t("有必要才补")],['high',t("主动递一句")]]},
    emoji:{title:t("表情符号"),opts:[['low',t("减弱")],['default',t("默认")],['high',t("增强")]]}
  };
  var SHORT={friendly:t("亲和友善"),professional:t("专业可靠"),direct:t("直言不讳"),playful:t("天马行空"),efficient:t("高效务实"),sharp:t("吐槽达人")};
  var TICK='<svg class="tick" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10.5l4 4 8-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var state=Object.assign({},F);
  function $(id){return document.getElementById(id);}
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function labelOf(key,v){
    var o=FIELDS[key].opts;
    for(var i=0;i<o.length;i++) if(o[i][0]===v) return o[i][1];
    return v;
  }
  function shortOf(key,v){
    if(key==='style') return SHORT[v]||labelOf(key,v);
    return labelOf(key,v);
  }

  function persona(p){
    var out=[];
    if(p.nickname&&p.nickname.trim())out.push('对方希望被叫作「'+p.nickname.trim()+'」。');
    if(p.aboutMe && p.aboutMe.trim()){
      out.push('');
      out.push('关于他（这是你要记住的）：');
      out.push(p.aboutMe.trim());
    }
    out.push('');
    out.push('说话基调：'+(STYLE[p.style]||STYLE.friendly)+'。');
    out.push('- 亲切程度：'+LVL[p.warmth]+'。'+(p.warmth==='high'?'用「你」「咱们」，不用「您」。':p.warmth==='low'?'保持专业距离，少用亲昵称呼。':'自然即可。'));
    out.push('- 热情程度：'+LVL[p.energy]+'。'+(p.energy==='high'?'愿意多说一句，但不堆感叹号。':p.energy==='low'?'只说必要的话，不扩写。':'按内容需要。'));
    out.push('- 主动程度：'+(PROACTIVE[p.proactive]||PROACTIVE.default)+'。');
    out.push('- 表情符号：'+(EMOJI[p.emoji]||EMOJI.default)+'。');
    out.push('- 不确定就说不确定；不总结、不喊口号、不反问「还需要什么」。');
    return out.join('\\n');
  }

  function syncPills(p){
    var pills=document.querySelectorAll('.pill');
    for(var i=0;i<pills.length;i++){
      var k=pills[i].getAttribute('data-key');
      var v=p[k];
      pills[i].setAttribute('data-v',v);
      pills[i].querySelector('.v').textContent=shortOf(k,v);
    }
  }

  function grow(){
    var t=$('aboutMe');
    t.style.height='auto';
    // 高度上限锁死：空内容或 WebView 把 scrollHeight 算大时，也不会把整页撑开
    t.style.height=Math.min(208,Math.max(116,t.scrollHeight||0))+'px';
    var n=(t.value||'').length;
    var c=$('count');
    c.textContent=n+' / 500';
    c.className='count'+(n>=450?' near':'');
  }

  function paint(){
    state.nickname=$('nickname').value;
    state.aboutMe=$('aboutMe').value;
    syncPills(state);
    $('preview').textContent=persona(state);
    grow();
    return state;
  }

  function fill(p){
    state=Object.assign({},F,p);
    $('nickname').value=state.nickname||'';
    $('aboutMe').value=state.aboutMe||'';
    paint();
  }

  /* ── 抽屉 ── */
  var curKey=null, lastFocus=null;
  function openSheet(key){
    curKey=key;
    var f=FIELDS[key];
    $('sheetTitle').textContent=f.title;
    var html='';
    for(var i=0;i<f.opts.length;i++){
      var o=f.opts[i];
      var on=(state[key]===o[0])?'true':'false';
      html+='<button class="opt" data-v="'+o[0]+'" aria-selected="'+on+'"><span>'+esc(o[1])+'</span>'+TICK+'</button>';
    }
    $('opts').innerHTML=html;
    $('scrim').classList.add('on');
    $('sheet').classList.add('on');
    lastFocus=document.activeElement;
    var sel=$('opts').querySelector('.opt[aria-selected="true"]');
    if(sel) setTimeout(function(){ sel.focus({preventScroll:true}); },60);
  }
  function closeSheet(){
    $('scrim').classList.remove('on');
    $('sheet').classList.remove('on');
    curKey=null;
    if(lastFocus && lastFocus.focus) lastFocus.focus({preventScroll:true});
  }

  $('opts').addEventListener('click',function(ev){
    var b=ev.target.closest('.opt');
    if(!b||!curKey) return;
    state[curKey]=b.getAttribute('data-v');
    paint();
    closeSheet();
  });
  $('scrim').addEventListener('click',closeSheet);
  $('sheet').addEventListener('click',function(ev){ if(ev.target.id==='sheet') closeSheet(); });
  document.addEventListener('keydown',function(ev){
    if(ev.key==='Escape' && curKey) closeSheet();
  });

  var pills=document.querySelectorAll('.pill');
  for(var i=0;i<pills.length;i++){
    (function(p){
      p.addEventListener('click',function(){ openSheet(p.getAttribute('data-key')); });
    })(pills[i]);
  }

  $('nickname').addEventListener('input',paint);
  $('aboutMe').addEventListener('input',paint);

  function boot(){
    fetch(API,{cache:'no-store'}).then(function(r){return r.json();}).then(function(p){
      if(p && p._error){
        $('err').innerHTML='<div class="err">'+t('读取失败：')+esc(p._error)+t('（当前是默认值，保存会覆盖）')+'</div>';
      }
      fill(p||F);
    }).catch(function(e){
      $('err').innerHTML='<div class="err">'+t('连不上引擎：')+esc(e&&e.message||e)+'</div>';
      fill(F);
    });
  }

  $('save').addEventListener('click',function(){
    var btn=this; paint();
    btn.disabled=true; btn.textContent=t("保存中…"); btn.className='';
    fetch(API,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(state)})
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(res){
        if(!res.ok) throw new Error(t("保存被拒"));
        $('err').innerHTML='';
        fill(res.profile);
        btn.textContent=t("已保存"); btn.className='done'; btn.disabled=true;
        setTimeout(function(){ btn.textContent=t("保存"); btn.className=''; btn.disabled=false; },1500);
      })
      .catch(function(e){
        $('err').innerHTML='<div class="err">'+t('保存失败：')+esc(e&&e.message||e)+'</div>';
        window.scrollTo({top:0,behavior:'smooth'});
        btn.textContent=t("保存"); btn.disabled=false;
      });
  });

  boot();
})();
</script>
</body>
</html>`;
