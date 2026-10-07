// 聊天流图片卡的共用视图：纸飞机（用户发的）与伙伴配图共用这一份。
// v0.1.17 - 按反馈把显示还原成插件版配图卡的样子：不显示卡片标题与来源小字，
// 图下方直接给「喜欢 / 应景 / 不喜欢」三键，反馈写进 App 自己的偏好账本
// （走 /api/message-card/feedback，按卡片记录里的表情包和伙伴落账）。
// v0.1.29 - 点过「不喜欢」之后多一个「和小花聊聊」：聊天面板就开在这张卡片里，
// 不另开一屏；模型给的改动建议以「现在 → 改完以后」逐行落在消息流末尾，
// 每行可以单独丢掉，底下一个大按钮确认，回包没接住就先回查落盘再说话。
import { hana } from './sdk.js';

// 宿主聊天列的窄档：宽度上限按老卡片保持 316，实际宽度跟着图片和用户的尺寸档位走。
const CARD_MAX_WIDTH = 316;
const CARD_MIN_WIDTH = 120;
// 固定档位的宽度（preferences 里头的 small / medium / large）
const MODE_WIDTH = { small: 180, medium: 240, large: CARD_MAX_WIDTH };
const DEFAULT_CONFIG = { sizeMode: 'auto', smallImageFit: true, smallImageThreshold: 200, showFeedbackButtons: true };
// v0.1.27 - 卡头标题由页面自己交给宿主。宿主清单里那个静态的「表情包」是分类名，
// 图片就在旁边，再说一遍等于什么也没说；这里按「谁发的 + 当时什么情绪」拼一句人话。
// 名字、情绪缺一个就退掉那一截，两个都缺也不能剩个空标题。
const USER_CARD_TITLE = '你丢了一张过来';
const PARTNER_NAME_MAX = 12;
const PARTNER_EMOTION_MAX = 8;

// 超长的、带引号换行的、不是字符串的一律当没有，宁可少写一截也不让标题里冒出半句脏字。
function titlePiece(value, maxLength) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[「」"']/g, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > maxLength) return '';
  return text;
}

function cardTitleFor({ sender, agentName, emotion } = {}) {
  if (sender !== 'partner') return USER_CARD_TITLE;
  const name = titlePiece(agentName, PARTNER_NAME_MAX);
  const mood = titlePiece(emotion, PARTNER_EMOTION_MAX);
  const head = name ? name + ' 顺手配了张' : '顺手配了张';
  return mood ? head + '「' + mood + '」的表情包' : head + '表情包';
}
// 图片自身的高度兜底：超过它的竖图按高度反推宽度，不让一张图顶出聊天流。
const CARD_MAX_IMAGE_HEIGHT = 320;
const BODY_PADDING = 12;
// v0.1.29 - 聊天面板的高度写死像素，跟 CSS 里 .chat-panel 的 height 一致。
// 不用 vh，理由跟图片高度上限那条一样：vh 就是宿主给的框，与上报高度互相驱动成循环。
const CHAT_PANEL_HEIGHT = 340;
// 建议卡里认得的字段和它们的中文名。不认识的一律不提交，宁可少改也不乱写。
const CHAT_FIELDS = ['description', 'semantic_description', 'emotion', 'scene', 'keywords'];
const CHAT_FIELD_LABELS = { description: '描述', semantic_description: '语义描述', emotion: '情绪', scene: '场景', keywords: '关键词' };
const CHAT_EMPTY_HINT = '这张图不太合适？说说哪里不对，我陪你调。\n比如：它表达的是撒娇，不是开心。';

// 建议里每个字段的「能看懂的样子」：数组用顿号连起来，空值当没有。
function formatTagValue(field, value) {
  if (Array.isArray(value)) return value.filter((item) => String(item ?? '').trim()).join('、');
  return String(value ?? '').trim();
}

// 只留下真的变了的字段：前后一模一样、或者建议里没给这个字段，都不进建议卡。
// 一条都没有时卡片自己会说「没看出要改的」，不拿空对照糊弄人。
function buildSuggestionRows(suggestion, oldTags) {
  const rows = [];
  for (const field of CHAT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(suggestion || {}, field)) continue;
    const before = formatTagValue(field, oldTags?.[field]);
    const after = formatTagValue(field, suggestion[field]);
    if (!after || after === before) continue;
    rows.push({ field, label: CHAT_FIELD_LABELS[field] || field, before, after });
  }
  return rows;
}

// 聊天出错时把内部话翻成人话。模型没配是最常见的一种，得指路。
function chatErrorText(raw) {
  const text = String(raw || '');
  // v0.1.30 - 聊天默认跟随伙伴当前模型；这条只在连伙伴模型和模型目录都拿不到时出现
  if (text.includes('没找到能聊天的模型')) {
    return '暂时没找到能用的模型：去设置里给这位伙伴选一个对话模型，再回来聊';
  }
  if (text.includes('内容分析模型未启用') || text.includes('请先在设置中选择内容分析模型')) {
    return '还没挑聊天用的模型：去表情包设置里选一个「内容分析模型」，再回来聊';
  }
  if (text.includes('会话已过期')) return '这轮上下文过期了，收起聊天再打开一次接着聊';
  if (text.includes('表情包不存在')) return '这张图已经不在图库里了，改不了标签';
  if (text.includes('空正文')) return '模型这轮只想了没说，再发一次试试';
  return text ? '没接上：' + text : '没接上，再试一次？';
}

// 回查落盘：改完了但回包没接住时，直接读图库看那几个字段是不是已经变成建议值了。
// 宁可多查一次，也不能把「其实改成功了」报成失败让用户重复点。
function stickerFieldValue(sticker, field) {
  if (!sticker) return '';
  if (field === 'description') return String(sticker.description || '').trim();
  if (field === 'semantic_description') return String(sticker.semantic_description || '').trim();
  return Array.isArray(sticker.tags?.[field]) ? sticker.tags[field] : [];
}

function patchLanded(sticker, patch) {
  return Object.keys(patch).every((field) =>
    formatTagValue(field, stickerFieldValue(sticker, field)) === formatTagValue(field, patch[field]));
}

export function mountMessageCard({ showCaption = false } = {}) {
  const message = document.querySelector('.message');
  const image = document.getElementById('image');
  const caption = document.getElementById('caption');
  const status = document.getElementById('status');
  const fbCard = document.getElementById('fb-card');
  const posBtn = document.getElementById('fb-pos');
  const fitBtn = document.getElementById('fb-fit');
  const negBtn = document.getElementById('fb-neg');
  const toast = document.getElementById('fb-toast');
  const chatRow = document.getElementById('fb-chat-row');
  const chatBtn = document.getElementById('fb-chat-btn');
  const chatPanel = document.getElementById('chat-panel');
  const chatThumb = document.getElementById('chat-thumb');
  const chatCollapse = document.getElementById('chat-collapse');
  const chatMsgs = document.getElementById('chat-msgs');
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send-btn');

  let generation = 0;
  let binding = '';
  let imageUrl = null;
  let lastSize = '';
  let recordId = '';
  let boundSessionId = '';
  let feedback = null;
  let feedbackKind = null;
  let pending = false;
  let queuedTap = null;
  let toastTimer = null;
  // 宿主递来空上下文时自己多试几次：它重新装载 App 后会补身份，偶尔也会迟一步。
  let reviveTimer = null;
  let reviveTries = 0;
  let config = { ...DEFAULT_CONFIG };
  // v0.1.29 - 内联聊天的状态。聊天不落盘：卡片被宿主重放（切窗口回来）时回到三键状态，
  // 聊天记录本来就在服务端会话里，收起或过期后重开会话，不假装还记得。
  let chatOpen = false;
  let chatStickerId = '';
  let chatSessionId = null;
  let chatBusy = false;
  let chatSuggestion = null;   // { rows: [...], fields: { 字段: 原始建议值 } }
  let chatDropped = new Set();
  let chatApplied = false;
  // v0.1.30 - 卡片记录里还留着上次没聊完的账（有聊天记录 / 已经销案）。
  // 有账时入口写「接着聊」，销案（确认改完）后记录清掉、返回「和小花聊聊」。
  let chatHasLog = false;
  let chatSettled = false;

  // 尺寸档位与反馈按钮开关都读同一份显示配置（偏好设置 → 配图卡片）。
  // 读不到就用默认值：卡片照常显示，不让配置读失败拖累图片。
  const configReady = (async () => {
    try {
      const response = await hana.api.fetch('/api/display-config');
      const result = await response.json();
      if (result?.ok && result.data) config = { ...DEFAULT_CONFIG, ...result.data };
    } catch { /* 用默认值 */ }
  })();

  // v0.1.23 - 图片高度上限已改回固定像素（页面 CSS 不再用 vh），这里继续按自然尺寸反推宽度。
  // 宽度跟图片自然尺寸算，不看渲染后的宽度：宿主按我们上报的值改窗宽，
  // 拿渲染宽度回算会自己卷成一个小盒子。
  // 档位（偏好设置 → 配图卡片）决定上限：auto = 小图原尺寸、大图填满聊天列；
  // small/medium/large = 对应档位宽，开着「小图自适应」时不把比档位小的图放大。
  function targetWidth() {
    // v0.1.29 - 聊天模式下不看图片多大，面板本身需要一整条宽度（窄图卡片也撑到上限）。
    if (chatOpen) return CARD_MAX_WIDTH;
    const naturalW = Number(image?.naturalWidth) || 0;
    const naturalH = Number(image?.naturalHeight) || 0;
    const mode = config.sizeMode || 'auto';
    const base = mode === 'auto' ? CARD_MAX_WIDTH : (MODE_WIDTH[mode] || CARD_MAX_WIDTH);
    if (config.smallImageFit === false) return base;   // 一律按档位尺寸，图片被放大填满
    if (!naturalW || !naturalH) return base;
    let shownW = naturalW;
    if (naturalH > CARD_MAX_IMAGE_HEIGHT) {
      shownW = Math.round(naturalW * CARD_MAX_IMAGE_HEIGHT / naturalH);
    }
    // 窄图时卡片由按钮行决定宽度，不然三个按钮会被挤掉
    const feedbackWidth = fbCard && !fbCard.hidden ? (fbCard.scrollWidth || 0) : 0;
    const chatWidth = chatRow && !chatRow.hidden ? (chatRow.scrollWidth || 0) : 0;
    const needed = Math.max(shownW, feedbackWidth, chatWidth) + BODY_PADDING;
    return Math.max(CARD_MIN_WIDTH, Math.min(base, Math.round(needed)));
  }

  // v0.1.26 - 高度不再量渲染结果，改成按「图片自然尺寸 + 我们上报的宽度」推算。
  // 渲染高度是被宿主给的框钳着的，而那个框又是我们自己报上去的：框矮 → 图被压小 →
  // 量到更小 → 再报更小，自锁在矮框里出不来（现场日志：1254x1254 的图在视口 51px 时
  // 被量成 316x51，和正确的 316x353 抢同一个框，来回把图压成一条）。
  // 只有图片高度需要推算；配文、按钮行、状态行的高度由内容决定，量 DOM 是准的。
  function measureHeight() {
    // v0.1.29 - 聊天模式下整个卡片就一个面板：高度跟 CSS 写死的面板高走，
    // 不去量渲染结果（那会被宿主给的框反向钉住，图片那一版已经吃过这个亏）。
    if (chatOpen) return CHAT_PANEL_HEIGHT + BODY_PADDING;
    const parts = [];
    const naturalW = Number(image?.naturalWidth) || 0;
    const naturalH = Number(image?.naturalHeight) || 0;
    if (image && !image.hidden) {
      if (naturalW > 0 && naturalH > 0) {
        // 与 CSS 一致：图片占满内容宽（body padding 左右各 6px），高度上限 320px。
        const contentW = Math.max(1, targetWidth() - BODY_PADDING);
        const scaled = Math.round(contentW * naturalH / naturalW);
        parts.push(Math.min(CARD_MAX_IMAGE_HEIGHT, scaled));
      } else {
        // 图片还没量到自然尺寸（比如加载中），这时才退回渲染高度当兜底。
        const rect = typeof image.getBoundingClientRect === 'function' ? image.getBoundingClientRect() : null;
        if (rect?.height) parts.push(Math.ceil(rect.height));
      }
    }
    // 空的行在 CSS 里是 display:none，量出来就是 0，所以只看高度，不用文本判断。
    const elementHeight = (element) => {
      if (!element || element.hidden) return 0;
      const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
      return rect?.height ? Math.ceil(rect.height) : 0;
    };
    parts.push(elementHeight(caption));
    // v0.1.31 - 入口行也要算进高度！
    // 卡片的框是按我们上报的高度开的，漏算哪一行，那一行就落在可视区外面被裁掉：
    // 入口明明显示了，用户却什么都看不到（2026-10-07 实机就撞在这里）。
    parts.push(elementHeight(chatRow));
    parts.push(elementHeight(fbCard));
    parts.push(elementHeight(status));
    const visible = parts.filter(part => part > 0);
    if (!visible.length) return 0;
    // .message 是 flex column、gap 8px：可见子元素之间各留一道。
    return visible.reduce((sum, part) => sum + part, 0) + (visible.length - 1) * 8 + BODY_PADDING;
  }

  // v0.1.17 - force 用于「页面重新可见 / 卡片重新挂载」：宿主可能已经丢了我们的尺寸，
  // 只看变化会漏报，卡片就会停在宿主给的那个大框上。
  // v0.1.23 - 加 1px 容差：宿主改框会触发 ResizeObserver 回环，容差挡掉亚像素级的来回报，
  // 避免尺寸在 1~2px 之间反复弹（逐次都报会把宿主也拖进循环）。
  let lastW = 0;
  let lastH = 0;
  function resize(force = false) {
    // v0.1.26 - 看不见的实例不上报尺寸。切换对话框时宿主会把同一个卡另挂到视口宽 0 的框里，
    // 那时量到的宽高都是残值（现场日志里的 316x51、vw=0），报上去只会把可见实例
    // 已经撑好的框压扁、图只剩一条。
    if (document.hidden || !window.innerWidth) return;
    const height = measureHeight();
    if (!height) return;
    const width = targetWidth();
    const size = width + 'x' + height;
    const steady = Math.abs(width - lastW) <= 1 && Math.abs(height - lastH) <= 1;
    if (!force && (size === lastSize || steady)) return;
    lastSize = size;
    lastW = width;
    lastH = height;
    // 尺寸现场：记下我们报了多大、图片自然尺寸（宽x高）、宿主真正给的可视宽高。
    // v0.1.23 - 补上 vw：宽度是否被宿主采纳，看这一栏就知道（之前只记 vh，宽度全靠猜）。
    const natural = Number(image?.naturalWidth) || 0;
    const naturalH = Number(image?.naturalHeight) || 0;
    const viewport = Number(window?.innerHeight) || 0;
    const viewportW = Number(window?.innerWidth) || 0;
    report('SIZE ' + size + ' nat=' + natural + 'x' + naturalH + ' vw=' + viewportW + ' vh=' + viewport);
    try {
      const out = hana.ui.resize({ width, height });
      if (out && typeof out.catch === 'function') {
        out.catch((error) => report('RESIZE-FAIL ' + size + ' ' + (error?.message || error)));
      }
    } catch (error) {
      report('RESIZE-THROW ' + size + ' ' + (error?.message || error));
    }
    verifyApplied(width, height);
  }

  // v0.1.23 - 上报后自检：宿主偶尔不按请求开框（卡片重放路径上见过）。
  // 等一拍看实际尺寸对不对，不对就再报一次，最多两次，不会无限循环。
  let verifyTimer = null;
  let verifyTries = 0;
  function verifyApplied(width, height) {
    clearTimeout(verifyTimer);
    if (verifyTries >= 2) return;
    verifyTimer = setTimeout(() => {
      const gotW = Number(window.innerWidth) || 0;
      const gotH = Number(window.innerHeight) || 0;
      if (!gotW && !gotH) return;  // 没有真实视口信息（非浏览器环境）就不检
      if (Math.abs(gotW - width) <= 4 && Math.abs(gotH - height) <= 4) return;
      verifyTries++;
      report('VERIFY-MISS want=' + width + 'x' + height + ' got=' + gotW + 'x' + gotH);
      resize(true);
    }, 400);
  }

  // 卡头标题：宿主清单里那个静态标题只在页面交上来之前露一下。
  // revision 在同一视图内必须严格递增，所以这里自己记一个计数。
  // 2026-10-07 - 聊天流里的卡有时是「先挂上、后绑身份」（切窗口回来、App 重载后最常见），
  // 交一次被拒就不再管的话，标题会一直停在清单里那句静态文案。这里只对「还没绑定」这一种
  // 错误按 1.5 秒退避重试三次，成功即停；一直绑不上（宿主对消息流里的卡不给视图身份）
  // 就老实收手，不刷日志。其余错误（负载不合法、身份过期）重试也没用，照旧记一笔。
  const CHROME_RETRY_LIMIT = 3;
  const CHROME_RETRY_DELAY_MS = 1500;
  let chromeRevision = 0;
  let chromeRetries = 0;
  let chromeRetryTimer = 0;

  function setCardHeader(title) {
    if (!title) return;
    if (!hana?.chrome || typeof hana.chrome.set !== 'function') return;
    chromeRevision += 1;
    try {
      const out = hana.chrome.set({ revision: chromeRevision, title, titleMode: 'show' });
      if (out && typeof out.then === 'function') {
        out.then(() => { chromeRetries = 0; }).catch((error) => retryCardHeader(title, error));
      }
    } catch (error) {
      retryCardHeader(title, error);
    }
  }

  function retryCardHeader(title, error) {
    const code = String(error?.code || '');
    if (code !== 'APP_CHROME_UNAVAILABLE') {
      report('CHROME-FAIL ' + (error?.message || error));
      return;
    }
    if (chromeRetries >= CHROME_RETRY_LIMIT) return;
    chromeRetries += 1;
    clearTimeout(chromeRetryTimer);
    chromeRetryTimer = setTimeout(() => setCardHeader(title), CHROME_RETRY_DELAY_MS);
  }

  function clearImage() {
    image.hidden = true;
    image.removeAttribute('src');
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
  }

  function showToast(text, isError = false) {
    if (!toast) return;
    toast.textContent = text || '';
    toast.style.color = isError ? '#b0546e' : '#2d3a35';
    toast.classList.toggle('show', !!text);
    clearTimeout(toastTimer);
    if (text) toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
  }

  function friendlyError(raw) {
    const text = String(raw || '');
    if (text.includes('没有对应的表情包') || text.includes('表情包不存在')) return '这张图不在图库里了，反馈记不下';
    if (text.includes('这条图片记录已不可用')) return '这条记录找不到了，刷新一下对话再看';
    if (text.includes('appSurfaceSession')) return '这个窗口刚打开，稍后再点一次';
    return '没记上：' + (text || '出错了');
  }

  function reflectFeedback() {
    const like = feedback === 'positive' && (feedbackKind === 'image' || feedbackKind === 'both');
    const fit = feedback === 'positive' && (feedbackKind === 'context' || feedbackKind === 'both');
    const negative = feedback === 'negative';
    if (posBtn) { posBtn.classList.toggle('on-love', like); posBtn.textContent = like ? '已喜欢' : '喜欢'; }
    if (fitBtn) { fitBtn.classList.toggle('on-fit', fit); fitBtn.textContent = fit ? '已应景' : '应景'; }
    if (negBtn) { negBtn.classList.toggle('on-hate', negative); negBtn.textContent = negative ? '已反馈' : '不喜欢'; }
    syncChatEntry();
  }

  // v0.1.29 - 「和小花聊聊」只在点过「不喜欢」之后出现：入口轻一点，
  // 喜欢这张图的人不会被多余按钮打扰；已经打开聊天面板时它自然收起来。
  function syncChatEntry() {
    if (!chatRow) return;
    if (chatBtn) chatBtn.textContent = chatHasLog ? '接着聊' : '和小花聊聊';
    const shouldShow = Boolean(feedback === 'negative' && chatStickerId && !chatOpen);
    // 没变就不折腾：尺寸上报是个来回，多余的上报会把宿主也拖进重排
    if (chatRow.hidden === !shouldShow) return;
    chatRow.hidden = !shouldShow;
    // v0.1.31 - 入口出现/消失都会改变卡片高度，当场重报一次，
    // 否则按钮落在外头，用户看到的就是「点了没反应」。
    resize(false);
  }

  // 三键状态由后端算（同维度再点=取消、跨维度=叠加、both 再点剩另一个），
  // 前端只负责把最后一次点击送出去，pending 期间连点不留静默丢单。
  async function sendFeedback(tapped) {
    if (!recordId) return;
    if (pending) { queuedTap = tapped; return; }
    pending = true;
    const previous = { feedback, feedbackKind };
    try {
      const response = await hana.api.fetch('/api/message-card/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: recordId, feedbackKind: tapped }),
      });
      const result = await response.json().catch(() => null);
      if (!result?.ok) throw new Error(result?.error || '反馈没记上');
      feedback = result.feedback || null;
      feedbackKind = result.feedbackKind || null;
      reflectFeedback();
      showToast(result.message || '已记下');
    } catch (error) {
      feedback = previous.feedback;
      feedbackKind = previous.feedbackKind;
      reflectFeedback();
      showToast(friendlyError(error?.message), true);
    }
    pending = false;
    if (queuedTap) { const next = queuedTap; queuedTap = null; sendFeedback(next); }
  }

  // ═══════ 内联聊天（v0.1.29） ═══════
  // 点过「不喜欢」后的「和小花聊聊」：聊明白才出建议，用户点「确认修改」才落盘；
  // 回包没接住时先回查图库，不让「其实改成功了」被报成失败。

  const canBuild = () => typeof document.createElement === 'function';

  function clearChildren(element) {
    if (!element) return;
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function setChatBusy(busy) {
    chatBusy = busy;
    if (chatSendBtn) {
      chatSendBtn.disabled = busy;
      chatSendBtn.textContent = busy ? '想想…' : '发送';
    }
  }

  function appendChatMsg(kind, text) {
    if (!chatMsgs || !canBuild()) return null;
    const empty = typeof chatMsgs.querySelector === 'function' ? chatMsgs.querySelector('.chat-empty') : null;
    if (empty && typeof empty.remove === 'function') empty.remove();
    const bubble = document.createElement('div');
    bubble.className = 'chat-msg chat-msg-' + kind;
    bubble.textContent = text;
    if (typeof chatMsgs.appendChild === 'function') chatMsgs.appendChild(bubble);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
    resize(false);
    return bubble;
  }

  // 失败/进度文案就写在建议卡里（不另开弹层），按钮原地保留，用户能接着聊或重试。
  function setChatNote(text) {
    const note = chatSuggestion?.note;
    if (!note) return;
    note.textContent = text || '';
    note.hidden = !text;
  }

  function chatPatch() {
    const patch = {};
    for (const row of chatSuggestion?.rows || []) {
      if (chatDropped.has(row.field)) continue;
      patch[row.field] = chatSuggestion.fields[row.field];
    }
    return patch;
  }

  function describePatch(patch) {
    return Object.entries(patch)
      .map(([field, value]) => (CHAT_FIELD_LABELS[field] || field) + '改成「' + formatTagValue(field, value) + '」')
      .join('；');
  }

  // 建议卡就长在消息流末尾（跟着滚），不另开一屏：
  // 每行「现在 → 改完以后」+ 单行「这条不要」，卡底一个总的应用按钮。
  function renderSuggestion(suggestion, oldTags, dropped = []) {
    const rows = buildSuggestionRows(suggestion, oldTags);
    const fields = {};
    for (const row of rows) fields[row.field] = suggestion[row.field];
    chatSuggestion = { rows, fields, el: null, note: null };
    // 恢复记录时把「哪几条不要了」一并带回来
    chatDropped = new Set(Array.isArray(dropped) ? dropped : []);
    chatApplied = false;
    if (!chatMsgs || !canBuild()) return;

    // 上一轮的建议已经过时（对话又往下走了），先请它退场，别堆一长串对照
    const previous = typeof chatMsgs.querySelector === 'function' ? chatMsgs.querySelector('.chat-sug') : null;
    if (previous && typeof previous.remove === 'function') previous.remove();

    const card = document.createElement('div');
    card.className = 'chat-sug';
    const head = document.createElement('div');
    head.className = 'chat-sug-head';
    head.textContent = rows.length ? '小花想这么改（不想动的点「这条不要」）' : '小花暂时没看出要改哪儿，接着说说是哪里不对？';
    card.appendChild(head);

    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'sug-row';
      const label = document.createElement('span');
      label.className = 'sug-label';
      label.textContent = row.label + '：';
      const body = document.createElement('span');
      body.className = 'sug-body';
      const oldSpan = document.createElement('span');
      oldSpan.className = 'sug-old';
      oldSpan.textContent = row.before || '（无）';
      const newSpan = document.createElement('span');
      newSpan.className = 'sug-new';
      newSpan.textContent = '→ ' + row.after;
      body.appendChild(oldSpan);
      body.appendChild(newSpan);
      const drop = document.createElement('button');
      drop.className = 'sug-drop';
      drop.type = 'button';
      drop.textContent = '这条不要';
      if (chatDropped.has(row.field)) {
        line.classList.add('dropped');
        drop.textContent = '要改';
      }
      drop.addEventListener('click', () => {
        if (chatApplied) return;
        if (chatDropped.has(row.field)) {
          chatDropped.delete(row.field);
          line.classList.remove('dropped');
          drop.textContent = '这条不要';
        } else {
          chatDropped.add(row.field);
          line.classList.add('dropped');
          drop.textContent = '要改';
        }
      });
      line.appendChild(label);
      line.appendChild(body);
      line.appendChild(drop);
      card.appendChild(line);
    }

    const acts = document.createElement('div');
    acts.className = 'sug-acts';
    const note = document.createElement('span');
    note.className = 'sug-note';
    note.hidden = true;
    const yes = document.createElement('button');
    yes.className = 'sug-btn sug-btn-yes';
    yes.type = 'button';
    yes.textContent = '确认修改';
    yes.addEventListener('click', () => confirmChatSuggestion());
    const no = document.createElement('button');
    no.className = 'sug-btn';
    no.type = 'button';
    no.textContent = '再看看';
    no.addEventListener('click', () => {
      if (chatApplied) return;
      chatSuggestion = null;
      chatDropped = new Set();
      if (typeof card.remove === 'function') card.remove();
      resize(false);
    });
    acts.appendChild(note);
    if (rows.length) acts.appendChild(yes);
    acts.appendChild(no);
    card.appendChild(acts);

    chatSuggestion.el = card;
    chatSuggestion.note = note;
    chatSuggestion.yes = yes;
    chatMsgs.appendChild(card);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
    resize(false);
  }

  // 改完的回执：写清楚改了什么，按钮收掉，聊天流里也留一条，
  // 用户一眼能看到自己的反馈真的落了地（闭环不能断在这里）。
  function markChatApplied(patch) {
    chatApplied = true;
    chatDropped = new Set();
    // v0.1.30 - 标签写完，这张卡的聊天账就销了（服务端也把记录清掉），
    // 收起面板后回到干净的三键状态。
    chatHasLog = false;
    chatSettled = true;
    syncChatEntry();
    const card = chatSuggestion?.el;
    if (card && canBuild()) {
      const acts = typeof card.querySelector === 'function' ? card.querySelector('.sug-acts') : null;
      if (acts) {
        clearChildren(acts);
        const done = document.createElement('span');
        done.className = 'sug-done';
        done.textContent = '✓ 已改好';
        acts.appendChild(done);
      }
      const head = typeof card.querySelector === 'function' ? card.querySelector('.chat-sug-head') : null;
      if (head) head.textContent = '这次就改这么多';
    }
    if (chatMsgs && canBuild()) {
      const done = document.createElement('div');
      done.className = 'chat-msg chat-msg-bot';
      done.textContent = '改好咯：' + describePatch(patch) + '。下次配图会照这个来，要是还不对，回来再聊。';
      chatMsgs.appendChild(done);
      chatMsgs.scrollTop = chatMsgs.scrollHeight;
    }
    showToast('已改好');
    setChatBusy(false);
    resize(false);
  }

  async function verifyChatApplied(patch) {
    try {
      const response = await hana.api.fetch('/api/list?id=' + encodeURIComponent(chatStickerId));
      const result = await response.json().catch(() => null);
      const sticker = Array.isArray(result?.data) ? result.data[0] : null;
      return !!sticker && patchLanded(sticker, patch);
    } catch {
      return false;
    }
  }

  async function confirmChatSuggestion() {
    if (!chatSuggestion || chatBusy || chatApplied) return;
    const patch = chatPatch();
    if (!Object.keys(patch).length) {
      setChatNote('这几条你都不要了，那就再接着说说是哪里不对');
      return;
    }
    setChatBusy(true);
    setChatNote('正在改…');
    try {
      const response = await hana.api.fetch('/api/sticker/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: chatSessionId, sticker_id: chatStickerId, card_id: recordId, new_tags: patch }),
      });
      const result = await response.json().catch(() => null);
      if (result?.ok) { markChatApplied(patch); return; }
      // 回包说没成功，也可能是它自己写完了没答上来：先回查落盘，不急着让用户重试
      if (await verifyChatApplied(patch)) { markChatApplied(patch); return; }
      setChatNote('没改上：' + chatErrorText(result?.error || '结果没确认'));
    } catch {
      if (await verifyChatApplied(patch)) { markChatApplied(patch); return; }
      setChatNote('保存那一步没接上，建议先留着，可以再点一次');
    }
    setChatBusy(false);
  }

  async function sendChat() {
    const text = String(chatInput?.value || '').trim();
    if (!text || chatBusy || !chatStickerId) return;
    appendChatMsg('user', text);
    if (chatInput) chatInput.value = '';
    setChatBusy(true);
    const thinking = appendChatMsg('busy', '小花正在想…');
    try {
      const response = await hana.api.fetch('/api/sticker/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sticker_id: chatStickerId, card_id: recordId, message: text, session_id: chatSessionId }),
      });
      const result = await response.json().catch(() => null);
      // 失败回合也可能带回会话号，留着才能让下一句接着上文聊
      if (result?.session_id) chatSessionId = result.session_id;
      if (thinking && typeof thinking.remove === 'function') thinking.remove();
      if (result?.ok) {
        appendChatMsg('bot', result.reply || '（这轮没说话）');
        chatHasLog = true;
        if (result.suggestion) renderSuggestion(result.suggestion, result.old_tags || {});
        syncChatEntry();
      } else {
        appendChatMsg('err', chatErrorText(result?.error));
      }
    } catch {
      if (thinking && typeof thinking.remove === 'function') thinking.remove();
      appendChatMsg('err', '没接上模型，再试一次？');
    }
    setChatBusy(false);
  }

  function syncFeedbackVisibility() {
    if (fbCard) fbCard.hidden = !chatStickerId || config.showFeedbackButtons === false;
  }

  function openChat() {
    if (!chatStickerId) { showToast('这张图不在图库里，标签改不了', true); return; }
    chatOpen = true;
    if (chatPanel) chatPanel.hidden = false;
    if (image) image.hidden = true;
    if (caption) caption.hidden = true;
    if (fbCard) fbCard.hidden = true;
    syncChatEntry();
    // 缩略图跟图片用的是同一个 blob，收图不能把 URL 释放了
    if (chatThumb && image) {
      const source = typeof image.getAttribute === 'function' ? image.getAttribute('src') : image.src;
      if (source) { chatThumb.src = source; chatThumb.hidden = false; }
    }
    if (chatMsgs && canBuild() && !chatMsgs.firstChild) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = CHAT_EMPTY_HINT;
      chatMsgs.appendChild(empty);
    }
    resize(true);
    if (chatInput && typeof chatInput.focus === 'function') setTimeout(() => chatInput.focus(), 80);
  }

  // 收起：图片和三键回来。v0.1.30 - 不再清服务端会话，聊天记录也留着，
  // 再打开能接着看、接着聊；只有「确认改完」那一下才算销案。
  function closeChat() {
    if (!chatOpen) return;
    chatOpen = false;
    chatBusy = false;
    if (chatPanel) chatPanel.hidden = true;
    if (image && imageUrl) image.hidden = false;
    if (caption) caption.hidden = false;
    syncFeedbackVisibility();
    syncChatEntry();
    chatSuggestion = null;
    chatDropped = new Set();
    chatApplied = false;
    setChatBusy(false);
    // 已经销案的会话：收起时把残留的话清掉，下次点开是崭新的一轮
    if (chatSettled && !chatHasLog) {
      clearChildren(chatMsgs);
      chatSettled = false;
    }
    resize(true);
  }

  // 从卡片记录里把上次的聊天拿回来（重放、重装之后靠它接上）
  function restoreChatLog(data) {
    chatHasLog = false;
    chatSettled = false;
    if (!data || !Array.isArray(data.messages) || !data.messages.length) { syncChatEntry(); return; }
    if (!chatMsgs || !canBuild()) return;
    clearChildren(chatMsgs);
    for (const item of data.messages) {
      appendChatMsg(item.role === 'user' ? 'user' : 'bot', item.text);
    }
    if (data.suggestion) renderSuggestion(data.suggestion, data.oldTags || {}, data.dropped || []);
    chatHasLog = true;
    syncChatEntry();
  }

  // 卡片被宿主重放/切走时把聊天收干净
  function resetChatState() {
    chatOpen = false;
    chatBusy = false;
    chatSessionId = null;
    chatSuggestion = null;
    chatDropped = new Set();
    chatApplied = false;
    chatHasLog = false;
    chatSettled = false;
    if (chatPanel) chatPanel.hidden = true;
    clearChildren(chatMsgs);
    if (chatInput) chatInput.value = '';
    setChatBusy(false);
  }

  // 卡片认领自己的记录：先看宿主给的实例身份，再看窗口地址里带的记录编号。
  // 关掉对话再打开、或者应用重新装载之后，宿主重建的流内卡可能只剩会话身份，
  // 这时靠 instanceKey / URL 里的编号把记录认回来；都认不出才报错。
  function candidateIds(context) {
    const found = [];
    const take = (value) => {
      const text = typeof value === 'string' ? value.trim() : '';
      if (/^a_[0-9a-f]{20}$/.test(text) && !found.includes(text)) found.push(text);
    };
    take(context?.cardInstanceId);
    take(context?.instanceKey);
    try { new URLSearchParams(location.search).forEach(take); } catch { /* 没有地址可读 */ }
    try { if (location.hash.length > 1) new URLSearchParams(location.hash.slice(1)).forEach(take); } catch { /* 同上 */ }
    return found;
  }

  // 现场记录：卡片认领记录时把宿主给的身份和窗口地址记一笔（排障用，正常路径也记）。
  // 地址参数只记名称和短值，appSurfaceSession 那种长凭证只留个名，免得把日志刷满。
  function describeContext(context, found, tag) {
    let params = '';
    let hash = '';
    try {
      const usp = new URLSearchParams(location.search);
      params = [...usp.keys()]
        .map((key) => key + (key === 'appSurfaceSession' ? '=…' : '=' + String(usp.get(key)).slice(0, 60)))
        .join('&');
    } catch { /* 没有地址可读 */ }
    try { hash = String(location.hash || '').slice(0, 60); } catch { /* 同上 */ }
    return [tag, context?.cardInstanceId ?? null, context?.instanceKey ?? null,
      context?.embeddedSessionId ?? null, context?.originSessionId ?? null,
      context?.slot ?? null, location.pathname, params, hash, found.join(',')].join(' | ');
  }

  function report(note) {
    try { hana.api.fetch('/api/message-card-context?note=' + encodeURIComponent(note)).catch(() => {}); } catch { /* 上报失败不影响卡片 */ }
  }

  function scheduleRevive() {
    clearTimeout(reviveTimer);
    // v0.1.32 - 宿主重载 App / 重新挂载卡片时，身份可能晚一两拍才补上。
    // 窗口从 5 次×2 秒放宽到 8 次×1.5 秒，另加“页面重新可见就重置重试”。
    if (reviveTries >= 8) return;
    reviveTries++;
    reviveTimer = setTimeout(() => {
      const current = hana.surface.getContext();
      report(describeContext(current, candidateIds(current), 'REVIVE'));
      load(current);
    }, 1500);
  }

  async function load(context) {
    await configReady;
    const candidates = candidateIds(context);
    const incomingSession = context?.embeddedSessionId || context?.originSessionId || '';
    if (!candidates.length) {
      report(describeContext(context, candidates, 'MISS'));
      // v0.1.20 - 宿主会在卡片已经显示图片之后又推一个空上下文（编号、会话、槽位全空），
      // 从前那样会把已经载入的图直接抹掉，表现就是「图一闪而过变成一句提示」。
      if (recordId && (!incomingSession || incomingSession === boundSessionId)) { resize(true); return; }
      generation++; binding = ''; recordId = ''; boundSessionId = '';
      chatStickerId = '';
      resetChatState();
      clearImage();
      if (caption) caption.textContent = '';
      if (fbCard) fbCard.hidden = true;
      // 宿主给得出上下文却没给编号，和它什么都还没给，是两回事。
      if (context) {
        clearTimeout(reviveTimer);
        status.textContent = '这张图暂时认不出来，切到别的对话再切回来就好';
      } else if (reviveTries >= 8) {
        // v0.1.32 - 实测“重新装载 App”对这张卡反而更糟（重载会让卡片丢身份，要等宿主重新挂），
        // 真正管用的动作是让卡片重新挂一次：切走对话再切回来。
        status.textContent = '这张图暂时拿不到，切到别的对话再切回来就好';
      } else {
        status.textContent = '正在读取这张图片…';
        scheduleRevive();
      }
      resize(true);
      return;
    }
    const id = candidates[0];
    // 同一张卡重新出现在视图里（切走再切回来）：尺寸重新上报一次，别的都不动。
    if (binding === id) { resize(true); return; }
    binding = id;
    recordId = id;
    chatStickerId = '';
    resetChatState();
    const current = ++generation;
    clearImage();
    if (caption) caption.textContent = '';
    if (fbCard) fbCard.hidden = true;
    showToast('');
    status.textContent = '正在读取这张图片…';
    try {
      // 候选编号可能有多个：哪个查得到用哪个
      let result = null;
      for (const candidate of candidates) {
        const response = await hana.api.fetch('/api/paper-plane-message?id=' + encodeURIComponent(candidate));
        const payload = response.ok ? await response.json().catch(() => null) : null;
        if (payload?.ok && payload.data?.id === candidate) { result = payload; recordId = candidate; break; }
      }
      if (!result) throw new Error('这条图片记录已不可用');
      const query = '?id=' + encodeURIComponent(recordId);
      if (current !== generation) return;
      const sessionId = context.embeddedSessionId || context.originSessionId;
      if (!sessionId) throw new Error('这张图片卡没有所属对话，请从原对话打开');
      if (result.data.sessionId !== sessionId) throw new Error('图片记录不属于这段对话');
      boundSessionId = sessionId;
      const picture = await hana.api.fetch('/api/paper-plane-message/image' + query);
      if (!picture.ok) throw new Error('这张图片已不可用');
      const blob = await picture.blob();
      if (current !== generation) return;
      imageUrl = URL.createObjectURL(blob);
      image.src = imageUrl;
      image.hidden = false;
      // v0.1.33 - 两张流内卡合成一张后，配文按记录里的归属决定：伙伴配的图不配文（和拆卡时那张 partner 页一致）。
      if (showCaption && caption && result.data.sender !== 'partner') caption.textContent = result.data.text || '';
      feedback = result.data.feedback || null;
      feedbackKind = result.data.feedbackKind || null;
      chatStickerId = String(result.data.stickerId || '');
      // 图库里还认得这张图才给反馈入口；用户把反馈按钮关掉时也不显示。
      syncFeedbackVisibility();
      // 关掉「小图自适应」时图片放大填满档位宽；开着就按原尺寸（不放大防糊）。
      if (image.style) image.style.width = config.smallImageFit === false ? '100%' : '';
      reflectFeedback();
      // 标题用的归属、伙伴名和情绪都在这一支里才齐。
      setCardHeader(cardTitleFor({ sender: result.data.sender, agentName: result.data.agentName, emotion: result.data.emotion }));
      clearTimeout(reviveTimer);
      reviveTries = 0;
      status.textContent = '';
      // v0.1.30 - 这张卡可能还留着上次没聊完的账，拉回来接上（没有记录不是错误）
      try {
        const logResponse = await hana.api.fetch('/api/message-card/chat?id=' + encodeURIComponent(recordId));
        const logPayload = logResponse.ok ? await logResponse.json().catch(() => null) : null;
        if (current !== generation) return;
        restoreChatLog(logPayload?.data || null);
      } catch {
        restoreChatLog(null);
      }
      report(describeContext(context, candidates, 'HIT:' + recordId));
      resize(true);
    } catch (error) {
      if (current !== generation) return;
      binding = ''; recordId = ''; boundSessionId = '';
      feedback = null;
      feedbackKind = null;
      chatStickerId = '';
      resetChatState();
      clearImage();
      syncFeedbackVisibility();
      syncChatEntry();
      status.textContent = error?.message || '图片读取失败';
      resize(true);
    }
  }

  posBtn?.addEventListener('click', () => sendFeedback('image'));
  fitBtn?.addEventListener('click', () => sendFeedback('context'));
  negBtn?.addEventListener('click', () => sendFeedback('negative'));
  // v0.1.29 - 内联聊天的四个入口：开、收、发、回车发。
  chatBtn?.addEventListener('click', () => openChat());
  chatCollapse?.addEventListener('click', () => closeChat());
  chatSendBtn?.addEventListener('click', () => sendChat());
  chatInput?.addEventListener('keydown', (event) => {
    if (event?.key === 'Enter' && !event.shiftKey) {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      sendChat();
    }
  });
  // 输入长一点就长高一点，最多 72px（CSS 里也是这个上限），再多就面板内滚
  chatInput?.addEventListener('input', () => {
    if (!chatInput.style) return;
    const measured = Number(chatInput.scrollHeight) || 0;
    chatInput.style.height = measured ? Math.min(72, measured) + 'px' : '';
  });

  // 图片量到真实尺寸后再报一次：只报一次容易停在加载前的旧高度。
  image.addEventListener('load', () => { resize(true); requestAnimationFrame(() => resize(true)); });
  image.addEventListener('error', () => { clearImage(); status.textContent = '图片暂时无法显示'; resize(true); });
  if (typeof ResizeObserver === 'function' && message) {
    new ResizeObserver(() => resize(false)).observe(message);
  }
  // v0.1.32 - 重新可见时如果还没认领记录（重载 App / 换对话回来常见的状态），
  // 直接重置重试次数并立刻重跑一次：宿主这时通常刚好把身份补上了。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!recordId) { reviveTries = 0; load(hana.surface.getContext()); }
    resize(true);
  });
  window.addEventListener('pageshow', () => {
    if (!recordId) { reviveTries = 0; load(hana.surface.getContext()); }
    resize(true);
  });
  hana.surface.onContextChanged(load);
  hana.ready();
  load(hana.surface.getContext());
  window.addEventListener('pagehide', () => { generation++; clearImage(); });
}
