/**
 * Мост между Telegram Mini Apps и игрой.
 *
 * Telegram отдаёт всё колбэками — облако, язык, готовность. Через js_interop
 * их неудобно описывать, поэтому здесь они превращаются в обещания, а Dart
 * видит плоский набор функций. Ровно так же устроен мост к Яндексу.
 *
 * Вторая задача — сделать Telegram необязательным. Сборка, открытая по
 * обычной ссылке в браузере, — или та, чей скрипт Telegram не доехал, — обязана
 * играть дальше, просто без облака. Ничто ниже не бросает, если Telegram не
 * пришёл, и ничто не ждёт его дольше нескольких секунд.
 *
 * Скрипт Telegram подключается с async: синхронный тег в <head> держал бы всю
 * страницу, пока не ответит telegram.org, а он отвечает не везде и не всегда
 * быстро. Поэтому мост сам дожидается появления window.Telegram.
 */
(function () {
  'use strict';

  /** Сколько ждать, пока скрипт Telegram появится на странице. */
  var WAIT_MS = 3000;

  /**
   * Сколько ждать скрипт AdsGram. Дольше, чем Telegram: без Telegram игре
   * нечем сохраняться, и ждать его долго нельзя, а реклама никого не держит —
   * кнопка просто появится позже. Три секунды не хватало: на медленной сети
   * скрипт AdsGram не успевал, кнопки не было вовсе, и проверяющий AdsGram не
   * находил, где в игре реклама.
   */
  var ADS_WAIT_MS = 30000;

  var app = null;
  var initPromise = null;

  function webApp() {
    var tg = window.Telegram;
    return tg && tg.WebApp ? tg.WebApp : null;
  }

  /**
   * Запущены ли мы внутри Telegram. Сам скрипт Telegram объект WebApp
   * создаёт всегда, даже в обычном браузере, — внутри мессенджера его
   * отличает только непустая подписанная строка initData.
   */
  function inside(wa) {
    return !!(wa && typeof wa.initData === 'string' && wa.initData.length > 0);
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = new Promise(function (resolve) {
      var started = Date.now();
      (function poll() {
        var wa = webApp();
        if (wa) {
          if (!inside(wa)) return resolve(false);
          app = wa;
          try {
            // Во весь экран сразу: по умолчанию Telegram открывает игру
            // половинкой, и доска не помещается.
            wa.expand();
          } catch (e) {}
          try {
            // Свайп вниз в Telegram сворачивает приложение. У нас вниз
            // тянут список уровней и водят пальцем по улице — игра
            // сворачивалась бы посреди хода.
            if (wa.disableVerticalSwipes) wa.disableVerticalSwipes();
          } catch (e) {}
          return resolve(true);
        }
        if (Date.now() - started > WAIT_MS) return resolve(false);
        setTimeout(poll, 50);
      })();
    });
    return initPromise;
  }

  function cloud() {
    return app && app.CloudStorage ? app.CloudStorage : null;
  }

  /** Обещание вокруг колбэка облака; ошибка превращается в null. */
  function call(method, args) {
    return new Promise(function (resolve) {
      var cs = cloud();
      if (!cs || typeof cs[method] !== 'function') return resolve(null);
      try {
        cs[method].apply(cs, args.concat([function (err, value) {
          if (err) {
            console.warn('[weave] облако Telegram: ' + method + ' — ' + err);
            return resolve(null);
          }
          resolve(value);
        }]));
      } catch (e) {
        console.warn('[weave] облако Telegram: ' + method + ' бросил', e);
        resolve(null);
      }
    });
  }

  // --- реклама AdsGram -------------------------------------------------------
  //
  // AdsGram показывает рекламу только внутри Telegram: он сверяется с данными
  // запуска. Его скрипт подключён с async, как и скрипт Telegram, — поэтому
  // мост ждёт и его, но тоже не дольше нескольких секунд.

  var ads = null;
  // Последнее служебное событие AdsGram. По нему отказ show() делится на
  // «нет рекламы», «слишком часто» и прочие ошибки — игроку о них говорят
  // разное.
  var adEvent = '';

  function initAds(blockId, debug) {
    return new Promise(function (resolve) {
      if (!app || !blockId) return resolve(false);
      var started = Date.now();
      (function poll() {
        if (window.Adsgram && typeof window.Adsgram.init === 'function') {
          try {
            ads = window.Adsgram.init({ blockId: String(blockId), debug: !!debug });
            // Подписка гасит стандартные окна AdsGram — они по-английски и
            // поверх игры. Игроку ответит героиня, своими словами.
            ['onBannerNotFound', 'onNonStopShow', 'onTooLongSession', 'onError']
              .forEach(function (name) {
                ads.addEventListener(name, function () { adEvent = name; });
              });
            return resolve(true);
          } catch (e) {
            console.warn('[weave] AdsGram не завёлся', e);
            return resolve(false);
          }
        }
        if (Date.now() - started > ADS_WAIT_MS) return resolve(false);
        setTimeout(poll, 200);
      })();
    });
  }

  /**
   * Показать рекламу с наградой. Ответ — строка:
   *   watched  — досмотрел до конца, награду выдавать;
   *   skipped  — закрыл раньше;
   *   nofill   — рекламы под этого игрока сейчас нет;
   *   often    — смотрит подряд или сессия слишком долгая;
   *   error    — что-то сломалось при показе;
   *   none     — реклама не подключена.
   */
  function showRewarded() {
    return new Promise(function (resolve) {
      if (!ads) return resolve('none');
      adEvent = '';
      function why() {
        if (adEvent === 'onBannerNotFound') return 'nofill';
        if (adEvent === 'onNonStopShow' || adEvent === 'onTooLongSession') {
          return 'often';
        }
        return '';
      }
      try {
        ads.show().then(function (r) {
          resolve(r && r.done ? 'watched' : why() || 'skipped');
        }).catch(function (r) {
          resolve(why() || (r && r.error ? 'error' : 'skipped'));
        });
      } catch (e) {
        console.warn('[weave] AdsGram: show бросил', e);
        resolve('error');
      }
    });
  }

  // --- приглашения ------------------------------------------------------------

  /** Сервер бота (tool/bot/worker.js): ему игра сообщает о пришедшем друге. */
  var BOT_SERVER = 'https://weave-bot.mihailgimmelman90.workers.dev';

  function user() {
    try {
      return (app && app.initDataUnsafe && app.initDataUnsafe.user) || null;
    } catch (e) {
      return null;
    }
  }

  window.WeaveTelegram = {
    initAds: initAds,
    showRewarded: showRewarded,

    /** Номер игрока в Telegram строкой; '' — не в Telegram. */
    userId: function () {
      var u = user();
      return u && u.id ? String(u.id) : '';
    },

    /** Параметр из ссылки `…/play?startapp=<параметр>`; '' — его нет. */
    startParam: function () {
      try {
        return (app && app.initDataUnsafe && app.initDataUnsafe.start_param) || '';
      } catch (e) {
        return '';
      }
    },

    /**
     * Окно Telegram «Переслать»: игрок выбирает чат, в сообщении — текст и
     * ссылка. Своего сервера для этого не нужно.
     */
    share: function (url, text) {
      try {
        if (!app) return false;
        app.openTelegramLink(
          'https://t.me/share/url?url=' + encodeURIComponent(url) +
            '&text=' + encodeURIComponent(text)
        );
        return true;
      } catch (e) {
        console.warn('[weave] Telegram: поделиться не вышло', e);
        return false;
      }
    },

    /**
     * Разрешение боту писать игроку — без него бот не сможет сказать
     * пригласившему, что друг пришёл. Окно Telegram показывает один раз;
     * если разрешение уже есть, ответ приходит сразу.
     */
    requestWriteAccess: function () {
      return new Promise(function (resolve) {
        try {
          if (!app || typeof app.requestWriteAccess !== 'function') return resolve(false);
          var done = false;
          setTimeout(function () {
            if (!done) { done = true; resolve(false); }
          }, 60000);
          app.requestWriteAccess(function (granted) {
            if (!done) { done = true; resolve(!!granted); }
          });
        } catch (e) {
          resolve(false);
        }
      });
    },

    /**
     * Сказать боту, что игрок пришёл по приглашению [inviter]. Бот проверит
     * подпись данных запуска и напишет пригласившему. text/plain — чтобы
     * браузер не делал лишний предварительный запрос.
     */
    notifyJoined: function (inviter) {
      try {
        if (!app || !app.initData) return Promise.resolve(false);
        return fetch(BOT_SERVER + '/joined', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ initData: app.initData, inviter: String(inviter) }),
        }).then(function (r) {
          return r.ok;
        }, function () {
          return false;
        });
      } catch (e) {
        return Promise.resolve(false);
      }
    },

    /** true — игра открыта внутри Telegram и облако доступно. */
    init: init,

    isInside: function () {
      return !!app;
    },

    /** Снять заставку Telegram: игра нарисовала первый кадр. */
    ready: function () {
      try {
        if (app) app.ready();
      } catch (e) {}
    },

    /** Язык игрока из подписанных данных запуска: 'ru', 'en'… */
    language: function () {
      try {
        var user = app && app.initDataUnsafe && app.initDataUnsafe.user;
        return (user && user.language_code) || '';
      } catch (e) {
        return '';
      }
    },

    /** Значения по списку ключей одним запросом; JSON-строка объекта. */
    getItems: function (keys) {
      return call('getItems', [keys]).then(function (values) {
        return JSON.stringify(values || {});
      });
    },

    setItem: function (key, value) {
      return call('setItem', [key, value]).then(function (ok) {
        return !!ok;
      });
    },

    removeItems: function (keys) {
      return call('removeItems', [keys]).then(function (ok) {
        return !!ok;
      });
    },
  };
})();
