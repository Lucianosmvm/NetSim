/* ==========================================================================
   main.js — inicialização e laço principal (relógio da simulação + desenho)
   ========================================================================== */
(function (global) {
  'use strict';
  const PT = global.PT;

  function boot() {
    PT.ui.init();

    let last = performance.now();
    let queued = false;

    function step() {
      queued = false;
      const now = performance.now();
      const dt = Math.min(100, now - last);   // evita saltos gigantes ao voltar da aba
      last = now;
      PT.engine.tick(dt);
      if (!document.hidden) PT.ui.renderPackets();
      schedule();
    }

    // requestAnimationFrame não dispara com a aba oculta: cai para setTimeout
    function schedule() {
      if (queued) return;
      queued = true;
      if (document.hidden) setTimeout(step, 33);
      else requestAnimationFrame(step);
    }

    document.addEventListener('visibilitychange', () => { last = performance.now(); schedule(); });
    schedule();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
