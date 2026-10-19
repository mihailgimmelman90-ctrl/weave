/**
 * Мост между VK Mini Apps и игрой.
 *
 * VK Bridge (`vk_bridge_sdk.js`, официальная сборка @vkontakte/vk-bridge)
 * отдаёт всё обещаниями с ошибками в своём формате. Здесь они сводятся к
 * плоскому набору функций, которые никогда не бросают, — Dart видит
 * `window.WeaveVk`, ровно как видит мосты к Яндексу и Telegram.
 *
 * VK необязателен. Сборка, открытая по обычной ссылке, а не из VK, обязана
 * играть дальше — просто без облака и рекламы. Внутри VK страницу открывают
 * с подписанными параметрами запуска в адресе (vk_app_id, sign), по ним мост
 * и понимает, где он.
 */
(function () {
  'use strict';

  /** Сколько ждать ответа VK. Дольше — считаем, что его нет. */
  var WAIT_MS = 8000;

  var inside = false;
  var initPromise = null;

  function params() {
    try {
      return new URLSearchParams(window.location.search);
    } catch (e) {
      return null;
    }
  }

  function launchedFromVk() {
    var p = params();
    return !!(p && p.get('vk_app_id') && p.get('sign'));
  }

  function bridge() {
    var b = window.vkBridge;
    return b && typeof b.send === 'function' ? b : null;
  }

  /**
   * Вызов VK Bridge. Ответ — { ok, data } при успехе и { ok: false, error }
   * при ошибке или молчании дольше WAIT_MS. Не бросает никогда.
   */
  function call(method, args) {
    return new Promise(function (resolve) {
      var b = bridge();
      if (!b) return resolve({ ok: false, error: 'нет VK Bridge' });
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve({ ok: false, error: 'VK не ответил' });
      }, WAIT_MS);
      function finish(value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      }
      try {
        b.send(method, args || {}).then(
          function (data) {
            finish({ ok: true, data: data });
          },
          function (error) {
            console.warn('[weave] VK: ' + method + ' —', error && (error.error_data || error));
            finish({ ok: false, error: error });
          }
        );
      } catch (e) {
        console.warn('[weave] VK: ' + method + ' бросил', e);
        finish({ ok: false, error: e });
      }
    });
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = (function () {
      if (!launchedFromVk() || !bridge()) return Promise.resolve(false);
      // VKWebAppInit обязателен: без него VK держит над игрой заставку и
      // считает приложение неработающим.
      return call('VKWebAppInit').then(function (r) {
        inside = r.ok;
        return inside;
      });
    })();
    return initPromise;
  }

  window.WeaveVk = {
    /** true — игра открыта внутри VK и облако доступно. */
    init: init,

    isInside: function () {
      return inside;
    },

    /** Язык интерфейса VK из параметров запуска: 'ru', 'en'… */
    language: function () {
      var p = params();
      return (p && p.get('vk_language')) || '';
    },

    /** Значения по списку ключей; JSON-строка объекта { ключ: значение }. */
    getItems: function (keys) {
      if (!inside) return Promise.resolve('{}');
      return call('VKWebAppStorageGet', { keys: keys }).then(function (r) {
        var out = {};
        var list = (r.ok && r.data && r.data.keys) || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && typeof list[i].value === 'string') {
            out[list[i].key] = list[i].value;
          }
        }
        return JSON.stringify(out);
      });
    },

    setItem: function (key, value) {
      if (!inside) return Promise.resolve(false);
      return call('VKWebAppStorageSet', { key: key, value: value }).then(function (r) {
        return !!(r.ok && r.data && r.data.result);
      });
    },

    /** Удаления в хранилище VK нет: пустое значение и есть удаление. */
    removeItems: function (keys) {
      if (!inside) return Promise.resolve(false);
      return Promise.all(
        keys.map(function (key) {
          return call('VKWebAppStorageSet', { key: key, value: '' });
        })
      ).then(function (all) {
        return all.every(function (r) {
          return r.ok;
        });
      });
    },

    /**
     * Реклама с наградой есть внутри VK. Заодно просим VK заранее
     * подгрузить ролик, чтобы по нажатию он пошёл сразу.
     */
    initAds: function () {
      if (!inside) return Promise.resolve(false);
      call('VKWebAppCheckNativeAds', { ad_format: 'reward' });
      return Promise.resolve(true);
    },

    /**
     * Показать рекламу с наградой. Ответ — строка, как у моста к Telegram:
     *   watched — досмотрел, награду выдавать;
     *   skipped — закрыл раньше;
     *   nofill  — рекламы для игрока сейчас нет;
     *   error   — что-то сломалось;
     *   none    — мы не в VK.
     */
    showRewarded: function () {
      if (!inside) return Promise.resolve('none');
      return call('VKWebAppCheckNativeAds', { ad_format: 'reward' }).then(function (check) {
        if (check.ok && check.data && check.data.result === false) return 'nofill';
        return call('VKWebAppShowNativeAds', { ad_format: 'reward' }).then(function (r) {
          if (r.ok) return r.data && r.data.result ? 'watched' : 'skipped';
          // Чаще всего VK отказывает потому, что ролика под игрока нет.
          return 'nofill';
        });
      });
    },
  };
})();
