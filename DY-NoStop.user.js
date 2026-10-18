// ==UserScript==
// @name         抖音 阻止自动停止播放
// @name:en      DY-NoStop
// @namespace    https://github.com/ByronAsh/DY-NoStop
// @version      4.2.0
// @description  阻止抖音网页端非用户意图的自动暂停，放行用户主动暂停、切换视频、视口外视频、断网与播放结束，保护画中画
// @description:en  Stop Douyin from pausing your video on its own. User-initiated pauses, video switching, off-screen videos, offline state and ended playback are left alone; picture-in-picture is protected.
// @author       ByronAsh
// @license      MIT
// @homepageURL  https://github.com/ByronAsh/DY-NoStop
// @supportURL   https://github.com/ByronAsh/DY-NoStop/issues
// @updateURL    https://raw.githubusercontent.com/ByronAsh/DY-NoStop/main/DY-NoStop.user.js
// @downloadURL  https://raw.githubusercontent.com/ByronAsh/DY-NoStop/main/DY-NoStop.user.js
// @match        *://*.douyin.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.__dzNoAutoStop) return;
  window.__dzNoAutoStop = true;

  var VERSION = '4.3.0';
  var T0_WALL = Date.now();
  var T0_PERF = (window.performance && performance.now) ? performance.now() : Date.now();

  // ===== 可调参数 =====
  var KEEP_PLAYING_IN_BACKGROUND = true;  // true = 切标签页/最小化也继续播
  var USER_WIN        = 1500;   // 用户操作后多久内的暂停算「用户主动暂停」
  var URL_WIN         = 2500;   // 切换视频/页面后多久内的暂停算正常
  var RECENT_PLAY_WIN = 60000;  // 距上次播放超过这么久，看门狗不再恢复
  var MAX_HISTORY     = 100;    // 最多保留多少条记录
  var DEBUG_VERBOSE   = false;  // true = 放行的暂停也打印到控制台

  var proto = HTMLMediaElement.prototype;
  var nativePause = proto.pause;
  var nativePlay  = proto.play;

  var lastUserInput = 0;
  var lastUrlChange = 0;
  var lastPlayedAt  = 0;
  var lastTimeUpdateWrite = 0;
  var blockedCount  = 0;
  var lastBlock     = null;
  var recs          = [];     // 记录（勿用 history，会遮蔽 window.history）
  var seq           = 0;
  var userPaused    = new WeakSet();

  function now() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
  function clock() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
  }
  function shortStack() {
    var s = '';
    try { throw new Error('dz'); } catch (e) { s = e.stack || ''; }
    return s.split('\n').slice(1, 8).map(function (l) { return l.trim(); });
  }
  function isTop() { try { return window.top === window; } catch (e) { return false; } }

  // ---- 画中画 / 视口 判定 ----
  function isPiP(v) {
    try { return document.pictureInPictureElement === v; } catch (e) { return false; }
  }
  function isInViewport(v) {
    if (isPiP(v)) return true;
    try {
      var r = v.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      var iw = window.innerWidth || 0;
      var ih = window.innerHeight || 0;
      return r.bottom > 0 && r.top < ih && r.right > 0 && r.left < iw;
    } catch (e) { return true; }
  }
  function isLive(v) {
    return !v.paused && !v.ended && v.readyState > 2;
  }
  // 只统计正在出声的视频，静音预加载不算「别的在播」
  function isAudible(v) {
    return !v.paused && !v.ended && v.readyState > 2 && !v.muted && v.volume > 0;
  }
  function hasOtherPlaying(v) {
    var vs = document.getElementsByTagName('video');
    for (var i = 0; i < vs.length; i++) {
      var o = vs[i];
      if (o === v) continue;
      if (isPiP(o)) continue;
      if (isAudible(o)) return true;
    }
    return false;
  }
  function videoSnapshot(v) {
    if (!v) return {};
    return {
      rs: v.readyState,
      ct: isFinite(v.currentTime) ? Math.round(v.currentTime * 10) / 10 : null,
      dur: (v.duration && isFinite(v.duration)) ? Math.round(v.duration * 10) / 10 : null,
      inView: isInViewport(v),
      pip: isPiP(v)
    };
  }

  // ---- 记录用户交互意图 ----
  ['pointerdown', 'mousedown', 'touchstart', 'click', 'keydown', 'wheel']
    .forEach(function (t) {
      window.addEventListener(t, function () { lastUserInput = now(); }, true);
    });

  // ---- 记录 URL 变化（切视频 / SPA 跳转）----
  function markUrl() { lastUrlChange = now(); }
  try {
    var H = window.history;
    ['pushState', 'replaceState'].forEach(function (m) {
      var o = H[m];
      if (typeof o === 'function') {
        H[m] = function () { var r = o.apply(this, arguments); markUrl(); return r; };
      }
    });
  } catch (e) { /* ignore */ }
  window.addEventListener('popstate', markUrl, true);
  window.addEventListener('hashchange', markUrl, true);

  // ---- 播放状态来源：play() 调用 + playing 事件 + timeupdate 节流 ----
  document.addEventListener('playing', function (e) {
    var v = e.target;
    if (v && v.tagName === 'VIDEO') {
      lastPlayedAt = now();
      userPaused.delete(v);
    }
  }, true);

  document.addEventListener('timeupdate', function (e) {
    var v = e.target;
    if (!v || v.tagName !== 'VIDEO' || v.paused) return;
    var t = now();
    if (t - lastTimeUpdateWrite < 2000) return;
    lastTimeUpdateWrite = t;
    lastPlayedAt = t;
  }, true);

  // ---- 判定：放行返回原因字符串，拦截返回 null ----
  function shouldAllow(v, t) {
    if (t - lastUserInput < USER_WIN) return 'user-input';   // 用户主动
    if (userPaused.has(v))            return 'user-paused';  // 用户暂停过且未再播
    if (navigator.onLine === false)   return 'offline';      // 断网
    if (v.error)                      return 'media-error';  // 媒体错误
    if (v.ended)                      return 'ended';        // 正常播完
    if (!v.currentSrc && !v.src)      return 'no-source';    // 无源
    if (v.readyState === 0)           return 'no-data';      // 没拿到任何数据

    // 以下属「切换场景」，画中画视频一律跳过，保证小窗不被掐断
    if (!isPiP(v)) {
      if (t - lastUrlChange < URL_WIN) return 'url-change';  // 切视频/切页
      if (!isInViewport(v))            return 'offscreen';   // 不在视口内（抖音正常策略）
      if (hasOtherPlaying(v))          return 'other-playing'; // 已有别的视频在播
    }
    return null;                                             // 其余 = 自动停止
  }

  function record(act, why, v, t) {
    seq++;
    var snap = videoSnapshot(v);
    var item = {
      n: seq,
      time: clock(),
      at: t,
      uptimeMs: Math.round(t - T0_PERF),
      act: act,
      why: why || '',
      hidden: document.hidden,
      online: navigator.onLine,
      rs: snap.rs, ct: snap.ct, dur: snap.dur, inView: snap.inView, pip: snap.pip,
      stack: shortStack()
    };
    recs.push(item);
    if (recs.length > MAX_HISTORY) recs.shift();
    return item;
  }

  // ---- 拦截 pause ----
  proto.pause = function () {
    if (this.tagName !== 'VIDEO') return nativePause.apply(this, arguments);

    var v = this;
    var t = now();
    var why = shouldAllow(v, t);

    if (why) {
      if (why === 'user-input') userPaused.add(v);
      var it = record('ALLOW', why, v, t);
      if (DEBUG_VERBOSE) console.log('[dz] ' + it.time + ' 放行 pause（' + why + '）', it);
      return nativePause.apply(this, arguments);
    }

    blockedCount++;
    var b = record('BLOCK', null, v, t);
    lastBlock = b;
    console.warn('[dz-no-autostop] ' + b.time + ' 已阻止自动暂停（第 ' + blockedCount + ' 次）',
      { hidden: b.hidden, online: b.online, rs: b.rs, ct: b.ct, inView: b.inView, pip: b.pip });
    console.debug('[dz-no-autostop] 调用来源:\n  ' + b.stack.join('\n  '));
    return undefined;
  };
  proto.pause.__dzHook = VERSION;

  // ---- 跟踪 play ----
  proto.play = function () {
    if (this.tagName === 'VIDEO') {
      userPaused.delete(this);
      lastPlayedAt = now();
    }
    return nativePlay.apply(this, arguments);
  };

  // ---- 看门狗 ----
  setInterval(function () {
    if (document.hidden && !KEEP_PLAYING_IN_BACKGROUND) return;
    var t = now();
    if (t - lastUserInput < USER_WIN) return;
    if (t - lastUrlChange < URL_WIN) return;
    if (navigator.onLine === false) return;
    if (t - lastPlayedAt > RECENT_PLAY_WIN) return;

    var vs = document.getElementsByTagName('video');
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      if (!v.paused) continue;
      if (userPaused.has(v)) continue;
      if (v.ended || v.error) continue;
      if (!v.currentSrc && !v.src) continue;
      if (v.readyState < 2) continue;
      if (!isPiP(v)) {
        if (!isInViewport(v)) continue;    // 视口外的不碰，避免双音轨
        if (hasOtherPlaying(v)) continue;  // 已有别的在播就不动
      }
      try {
        var p = nativePlay.call(v);
        if (p && typeof p.catch === 'function') p.catch(function () {});
        var it = record('WATCHDOG', 'resumed', v, t);
        console.warn('[dz-no-autostop] ' + it.time + ' 看门狗恢复播放 (ct=' + it.ct + ' inView=' + it.inView + ' pip=' + it.pip + ')');
      } catch (e) { /* ignore */ }
    }
  }, 500);

  // ================= 调试接口 =================
  function hookActive() {
    try {
      var p = HTMLMediaElement.prototype.pause;
      if (p && p.__dzHook === VERSION) return true;
      var src = Function.prototype.toString.call(p);
      return src.indexOf('blockedCount') !== -1;
    } catch (e) { return false; }
  }

  function countByWhy(w) { return recs.filter(function (o) { return o.why === w; }).length; }

  var api = {
    version: VERSION,
    loaded: true,
    frame: isTop() ? 'top' : 'iframe',
    url: location.href,
    loadedAt: new Date(T0_WALL).toLocaleString(),

    get count() { return blockedCount; },
    get historyLength() { return recs.length; },

    check: function () {
      var t = now();
      var r = {
        已注入: true,
        版本: VERSION,
        运行位置: isTop() ? '主框架' : 'iframe',
        拦截钩子生效: hookActive(),
        累计拦截次数: blockedCount,
        最近拦截时间: lastBlock ? lastBlock.time : '（尚未拦截过）',
        最近拦截距现在: lastBlock ? Math.round(t - lastBlock.at) + ' ms' : null,
        看门狗恢复次数: api.log('WATCHDOG').length,
        放行次数: api.log('ALLOW').length,
        放行明细: {
          用户主动: countByWhy('user-input'),
          切视频: countByWhy('url-change'),
          视口外: countByWhy('offscreen'),
          已有别的在播: countByWhy('other-playing'),
          用户暂停过: countByWhy('user-paused'),
          断网: countByWhy('offline'),
          媒体错误: countByWhy('media-error'),
          播放结束: countByWhy('ended'),
          无源: countByWhy('no-source'),
          无数据: countByWhy('no-data')
        },
        记录条数: recs.length,
        页面在后台: document.hidden,
        网络在线: navigator.onLine,
        后台续播: KEEP_PLAYING_IN_BACKGROUND,
        详细模式: DEBUG_VERBOSE,
        脚本运行时长: Math.round(t - T0_PERF) + ' ms',
        视频元素: api.videos()
      };
      console.log('%c[dz] 体检结果', 'background:#1a7f37;color:#fff;padding:2px 6px');
      console.log(r);
      return r;
    },

    // 每个视频的可见性/画中画状态
    videos: function () {
      return Array.prototype.map.call(document.getElementsByTagName('video'), function (v, i) {
        var r;
        try { r = v.getBoundingClientRect(); } catch (e) { r = { x: 0, y: 0, width: 0, height: 0 }; }
        return {
          idx: i,
          paused: v.paused,
          live: isLive(v),
          audible: isAudible(v),
          pip: isPiP(v),
          inView: isInViewport(v),
          rs: v.readyState,
          ct: Math.round(v.currentTime),
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          src: String(v.currentSrc || v.src || '').slice(0, 60)
        };
      });
    },

    stats: function () {
      var t = now();
      return {
        version: VERSION,
        frame: isTop() ? 'top' : 'iframe',
        uptimeMs: Math.round(t - T0_PERF),
        blocked: blockedCount,
        records: recs.length,
        hookActive: hookActive(),
        lastBlockTime: lastBlock ? lastBlock.time : null,
        lastBlockAgoMs: lastBlock ? Math.round(t - lastBlock.at) : null,
        lastUserInputAgoMs: lastUserInput ? Math.round(t - lastUserInput) : null,
        lastUrlChangeAgoMs: lastUrlChange ? Math.round(t - lastUrlChange) : null,
        lastPlayedAgoMs: lastPlayedAt ? Math.round(t - lastPlayedAt) : null,
        hidden: document.hidden,
        online: navigator.onLine,
        keepBackground: KEEP_PLAYING_IN_BACKGROUND,
        verbose: DEBUG_VERBOSE,
        docPiP: !!(window.documentPictureInPicture && window.documentPictureInPicture.window),
        videos: api.videos()
      };
    },

    hookActive: hookActive,

    log: function (filter) {
      if (!filter || String(filter).toUpperCase() === 'ALL') return recs.slice();
      var f = String(filter).toUpperCase();
      return recs.filter(function (o) { return o.act === f; });
    },

    dump: function (filter) {
      var list = api.log(filter);
      if (!list.length) { console.log('[dz] 没有记录（filter=' + (filter || 'ALL') + '）'); return list; }
      console.log('%c[dz] 共 ' + list.length + ' 条（n 为全局序号）' + (filter ? '，filter=' + filter : ''),
        'background:#0969da;color:#fff;padding:2px 6px');
      list.forEach(function (o) {
        console.log('#' + o.n + '  ' + o.time + '  [' + o.act + ']' + (o.why ? '  ' + o.why : '') +
          '  hidden=' + o.hidden + '  online=' + o.online + '  readyState=' + o.rs +
          '  currentTime=' + o.ct + '  inView=' + o.inView + '  pip=' + o.pip);
        if (o.stack && o.stack.length) console.log('     ' + o.stack.join('\n     '));
      });
      return list;
    },

    last: function () { return recs.length ? recs[recs.length - 1] : null; },

    resetCount: function () { blockedCount = 0; lastBlock = null; console.log('[dz] 拦截计数已归零（记录保留）'); return 0; },

    clear: function () {
      recs.length = 0; seq = 0; blockedCount = 0; lastBlock = null;
      console.log('[dz] 记录与计数已清空');
      return 'cleared';
    },

    why: function (el) {
      var v = el || document.getElementsByTagName('video')[0];
      if (!v) return '页面上没有 video 元素';
      var r = shouldAllow(v, now());
      return r ? ('会放行，原因: ' + r) : '会拦截（判定为自动停止）';
    },

    verbose: function (on) {
      DEBUG_VERBOSE = (on !== false);
      console.log('[dz] verbose = ' + DEBUG_VERBOSE + (DEBUG_VERBOSE ? '（放行的暂停也会打印）' : ''));
      return DEBUG_VERBOSE;
    },

    setBackground: function (on) {
      KEEP_PLAYING_IN_BACKGROUND = (on !== false);
      console.log('[dz] 后台续播 = ' + KEEP_PLAYING_IN_BACKGROUND);
      return KEEP_PLAYING_IN_BACKGROUND;
    },

    nativePause: function (el) {
      var v = el || document.getElementsByTagName('video')[0];
      if (!v) return '没有 video';
      nativePause.call(v);
      return '已调用原生 pause（绕过拦截）';
    },
    nativePlay: function (el) {
      var v = el || document.getElementsByTagName('video')[0];
      if (!v) return '没有 video';
      var p = nativePlay.call(v);
      if (p && typeof p.catch === 'function') p.catch(function () {});
      return '已调用原生 play（绕过拦截）';
    },

    help: function () {
      console.log(
        '%c[dz] v' + VERSION + ' 调试接口\n' +
        '  __dz.check()              一键体检（注入/钩子/拦截次数/放行明细）\n' +
        '  __dz.videos()             列出每个视频的可见性与画中画状态\n' +
        '  __dz.stats()              详细状态\n' +
        '  __dz.count                累计拦截次数（属性）\n' +
        '  __dz.log("BLOCK")         历史记录（ALL / BLOCK / ALLOW / WATCHDOG）\n' +
        '  __dz.dump("BLOCK")        打印历史，含调用栈\n' +
        '  __dz.last()               最近一条记录\n' +
        '  __dz.why()                试算当前这次 pause 会被拦还是放行\n' +
        '  __dz.hookActive()         拦截钩子是否还生效\n' +
        '  __dz.verbose(true)        连放行的暂停也打印\n' +
        '  __dz.nativePause()        绕过拦截直接调原生 pause（对比测试）\n' +
        '  __dz.nativePlay()         绕过拦截直接调原生 play\n' +
        '  __dz.setBackground(false) 切走标签页时不续播\n' +
        '  __dz.resetCount()         只清计数\n' +
        '  __dz.clear()              清空全部\n' +
        '  __dzNoAutoStop            注入标志（布尔）',
        'background:#8250df;color:#fff;padding:2px 6px');
    }
  };

  window.__dz = api;
  window.__dzStats = function () { return api.stats(); };

  console.log('%c[dz-no-autostop] v' + VERSION + ' 已加载 ', 'background:#1a7f37;color:#fff',
    '后台续播=' + KEEP_PLAYING_IN_BACKGROUND, '| 执行 __dz.check() 体检，__dz.help() 看接口');
})();
