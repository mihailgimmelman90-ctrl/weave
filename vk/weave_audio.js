/**
 * Звук игры на Web Audio API.
 *
 * Раньше звук играл через audioplayers, а тот в вебе создаёт элементы
 * <audio>. Браузер считает такой элемент медиа и показывает для него
 * системный плеер: на десктопе — панель управления мультимедиа, на телефоне —
 * карточку в шторке уведомлений. Площадка запрещает и то, и другое
 * (пп. 1.6.2.5 и 1.6.1.6) и прямо советует Web Audio.
 *
 * Здесь медиаэлементов нет вовсе: буферы декодируются один раз и играются
 * через AudioBufferSourceNode. Браузеру нечего показывать в плеере, потому
 * что никакого «трека» с точки зрения системы не существует.
 *
 * Звук — украшение, а не зависимость: всё, что здесь может не получиться,
 * заканчивается тишиной, а не ошибкой наружу.
 */
(function () {
  'use strict';

  var ctx = null;
  var buffers = {};
  var loopSource = null;
  var unlocked = false;

  function context() {
    if (ctx) return ctx;
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    } catch (e) {
      console.warn('[weave] web audio unavailable', e);
      ctx = null;
    }
    return ctx;
  }

  // Браузер не даёт играть до первого жеста игрока. Первый же тап по узлу
  // такой жест и есть, но контекст к этому моменту уже создан и усыплён,
  // поэтому его надо разбудить — иначе первый щипок пропадёт молча.
  function unlock() {
    var c = context();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(function () {});
    unlocked = true;
  }

  ['pointerdown', 'touchstart', 'keydown'].forEach(function (name) {
    window.addEventListener(name, unlock, { passive: true });
  });

  var api = {};

  /**
   * Скачивает и декодирует звуки. Имя — ключ, по которому его потом играют.
   * Ошибка на одном файле не мешает остальным: не декодировался — просто не
   * будет звучать.
   */
  api.load = function (files) {
    var c = context();
    if (!c) return Promise.resolve(false);

    var jobs = Object.keys(files).map(function (name) {
      return fetch(files[name])
        .then(function (r) {
          if (!r.ok) throw new Error(r.status + ' ' + files[name]);
          return r.arrayBuffer();
        })
        .then(function (raw) {
          // Старый вариант decodeAudioData принимает колбэки, а не промис;
          // оборачиваем, чтобы работало и там, и там.
          return new Promise(function (resolve, reject) {
            var out = c.decodeAudioData(raw, resolve, reject);
            if (out && typeof out.then === 'function') out.then(resolve, reject);
          });
        })
        .then(function (buffer) {
          buffers[name] = buffer;
        })
        .catch(function (e) {
          console.warn('[weave] sound failed: ' + name, e);
        });
    });

    return Promise.all(jobs).then(function () {
      return Object.keys(buffers).length > 0;
    });
  };

  function source(name, volume, loop) {
    var c = context();
    if (!c || !buffers[name]) return null;
    if (!unlocked) unlock();

    var node = c.createBufferSource();
    node.buffer = buffers[name];
    node.loop = !!loop;

    var gain = c.createGain();
    gain.gain.value = typeof volume === 'number' ? volume : 1;

    node.connect(gain);
    gain.connect(c.destination);
    return node;
  }

  /** Разовый звук. Наложения не мешают друг другу: каждый на своём узле. */
  api.play = function (name, volume) {
    try {
      var node = source(name, volume, false);
      if (node) node.start(0);
    } catch (e) {
      /* тишина лучше падения */
    }
  };

  /** Фоновая петля. Вторая поверх первой не пойдёт — предыдущая гасится. */
  api.loop = function (name, volume) {
    try {
      api.stopLoop();
      var node = source(name, volume, true);
      if (!node) return;
      loopSource = node;
      node.start(0);
    } catch (e) {
      /* тишина лучше падения */
    }
  };

  api.stopLoop = function () {
    if (!loopSource) return;
    try {
      loopSource.stop(0);
    } catch (e) {
      /* уже остановлена */
    }
    loopSource = null;
  };

  /** Есть ли вообще чем играть — Dart по этому решает, включать ли звук. */
  api.ready = function () {
    return context() !== null && Object.keys(buffers).length > 0;
  };

  window.WeaveAudio = api;
})();
