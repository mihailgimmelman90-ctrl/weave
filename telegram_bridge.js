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

  window.WeaveTelegram = {
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
