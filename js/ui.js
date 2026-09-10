/* ==========================================================================
   ui.js — área de trabalho lógica (SVG), paleta, ferramentas, janelas de
   configuração, terminais e registro de eventos.
   ========================================================================== */
(function (global) {
  'use strict';
  const PT = global.PT;
  const U = PT.util;
  const M = PT.model;
  const S = M.store;
  const doc = document;

  const NS = 'http://www.w3.org/2000/svg';
  const UI = {
    tool: 'select',
    cable: 'auto',
    armedType: null,      // tipo de dispositivo a inserir
    selected: null,       // {kind:'dev'|'link', id}
    cableStart: null,     // {dev, port}
    pduFrom: null,        // origem escolhida para o pacote simples
    pdus: [],             // histórico dos pacotes de teste enviados
    simFilters: { arp: true, icmp: true, dhcp: true, dns: true, outros: true },
    view: { x: 0, y: 0, w: 1200, h: 700 },
    filters: { arp: true, icmp: true, sw: true, other: true },
    windows: []
  };

  /* ------------------------------------------------------------------ ícones */
  const ICONS = {
    router: `
      <circle r="23" fill="#1f4f7a" stroke="#7cc0ef" stroke-width="2"/>
      <g stroke="#e8f4ff" stroke-width="2" fill="none" stroke-linecap="round">
        <path d="M-12,-6 H8 M4,-10 l5,4 -5,4"/>
        <path d="M12,6 H-8 M-4,2 l-5,4 5,4"/>
        <path d="M-6,-12 V-2 M-10,-8 l4,-5 4,5" transform="translate(-2,0)"/>
        <path d="M6,12 V2 M10,8 l-4,5 -4,-5" transform="translate(2,0)"/>
      </g>`,
    switch: `
      <rect x="-28" y="-15" width="56" height="30" rx="4" fill="#274b6d" stroke="#7cc0ef" stroke-width="2"/>
      <g stroke="#e8f4ff" stroke-width="2" fill="none" stroke-linecap="round">
        <path d="M-18,-6 H14 M10,-10 l5,4 -5,4"/>
        <path d="M18,6 H-14 M-10,2 l-5,4 5,4"/>
      </g>`,
    hub: `
      <rect x="-28" y="-14" width="56" height="28" rx="4" fill="#4b3a72" stroke="#c0a8f0" stroke-width="2"/>
      <g fill="#e6dcff"><circle cx="-16" cy="0" r="3"/><circle cx="-6" cy="0" r="3"/>
      <circle cx="4" cy="0" r="3"/><circle cx="14" cy="0" r="3"/></g>`,
    pc: `
      <rect x="-21" y="-19" width="42" height="29" rx="2" fill="#243447" stroke="#8fb4d9" stroke-width="2"/>
      <rect x="-17" y="-15" width="34" height="21" fill="#3fa9f5" opacity=".55"/>
      <path d="M-9,10 h18 l4,8 h-26 z" fill="#243447" stroke="#8fb4d9" stroke-width="2"/>`,
    laptop: `
      <path d="M-18,-16 h36 v22 h-36 z" fill="#243447" stroke="#8fb4d9" stroke-width="2"/>
      <rect x="-14" y="-12" width="28" height="15" fill="#3fa9f5" opacity=".55"/>
      <path d="M-26,7 h52 l4,7 h-60 z" fill="#2f4257" stroke="#8fb4d9" stroke-width="2"/>`,
    server: `
      <rect x="-15" y="-25" width="30" height="50" rx="3" fill="#243447" stroke="#8fb4d9" stroke-width="2"/>
      <g fill="#5fd08a"><rect x="-10" y="-19" width="20" height="4"/><rect x="-10" y="-10" width="20" height="4"/>
      <rect x="-10" y="-1" width="20" height="4"/></g>
      <circle cx="0" cy="16" r="3" fill="#f6c453"/>`
  };

  /* ------------------------------------------------------------------ util DOM */
  function el(tag, attrs, html) {
    const e = doc.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(k => e.setAttribute(k, attrs[k]));
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function sEl(tag, attrs, html) {
    const e = doc.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(k => e.setAttribute(k, attrs[k]));
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function $(sel) { return doc.querySelector(sel); }

  function toast(msg, isErr) {
    const t = el('div', { class: 'toast' + (isErr ? ' err' : '') }, U.esc(msg));
    doc.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  /* ================================================================== canvas */
  let svg, gLinks, gNodes, gPkts, gOver, hint;

  function initCanvas() {
    svg = $('#canvas');
    svg.innerHTML = '';
    const vp = sEl('g', { id: 'viewport' });
    gLinks = sEl('g'); gNodes = sEl('g'); gPkts = sEl('g'); gOver = sEl('g');
    vp.appendChild(gLinks); vp.appendChild(gNodes); vp.appendChild(gPkts); vp.appendChild(gOver);
    svg.appendChild(vp);
    hint = $('#statusHint');
    applyView();

    svg.addEventListener('mousedown', onCanvasDown);
    svg.addEventListener('mousemove', onCanvasMove);
    window.addEventListener('mouseup', onCanvasUp);
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('click', onCanvasClick);
    svg.addEventListener('dblclick', onCanvasDblClick);
    svg.addEventListener('contextmenu', e => { e.preventDefault(); closePortMenu(); UI.cableStart = null; drawRubber(null); setHint(); });
  }

  function applyView() {
    const v = UI.view;
    // proteção: se algum valor virar NaN/Infinity (janela ainda sem tamanho), volta ao padrão
    if (![v.x, v.y, v.w, v.h].every(Number.isFinite) || v.w <= 0 || v.h <= 0) {
      UI.view = { x: 0, y: 0, w: 1200, h: 700 };
      return applyView();
    }
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    const box = svg.getBoundingClientRect();
    const z = box.width ? Math.round(100 * box.width / v.w) : 100;
    $('#zoomVal').textContent = z + '%';
  }

  function pt(evt) {
    const r = svg.getBoundingClientRect();
    const v = UI.view;
    return {
      x: v.x + (evt.clientX - r.left) / r.width * v.w,
      y: v.y + (evt.clientY - r.top) / r.height * v.h
    };
  }

  function zoomBy(f, cx, cy) {
    const v = UI.view;
    const nw = U.clamp(v.w * f, 300, 5000);
    const nh = nw * (v.h / v.w);
    if (cx !== undefined) {
      v.x = cx - (cx - v.x) * (nw / v.w);
      v.y = cy - (cy - v.y) * (nh / v.h);
    }
    v.w = nw; v.h = nh;
    applyView();
  }

  function onWheel(e) {
    e.preventDefault();
    const p = pt(e);
    zoomBy(e.deltaY > 0 ? 1.12 : 0.89, p.x, p.y);
  }

  function fitView() {
    const ds = S.list();
    if (!ds.length) { UI.view = { x: 0, y: 0, w: 1200, h: 700 }; applyView(); return; }
    const xs = ds.map(d => d.x), ys = ds.map(d => d.y);
    const pad = 120;
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
    const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const r = svg.getBoundingClientRect();
    const ar = (r.width > 0 && r.height > 0) ? r.height / r.width : 700 / 1200;
    let w = Math.max(400, x1 - x0), h = Math.max(300, y1 - y0);
    if (h / w < ar) h = w * ar; else w = h / ar;
    UI.view = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
    applyView();
  }

  /* ------------------------------------------------------------- desenho */
  function nodeCenter(d) { return { x: d.x, y: d.y }; }

  function render() {
    // ---- cabos
    gLinks.innerHTML = '';
    S.linkList().forEach(l => {
      const e = M.linkEnds(l);
      if (!e.da || !e.db) return;
      const a = nodeCenter(e.da), b = nodeCenter(e.db);
      const up = M.linkUp(l);
      const cls = 'link ' + (up ? 'up' : 'down') + (l.cable === 'serial' ? ' serial' : '');

      const hit = sEl('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: 'transparent',
        'stroke-width': 14, 'data-link': l.id, style: 'cursor:pointer'
      });
      const ln = sEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: cls, 'data-link': l.id });
      gLinks.appendChild(ln); gLinks.appendChild(hit);

      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      [[a, 1], [b, -1]].forEach(([p, s]) => {
        gLinks.appendChild(sEl('circle', {
          cx: p.x + ux * 30 * s, cy: p.y + uy * 30 * s, r: 4,
          class: 'linkLed ' + (up ? 'up' : 'down')
        }));
      });
      // rótulos das portas
      gLinks.appendChild(sEl('text', {
        x: a.x + ux * 48, y: a.y + uy * 48 - 6, class: 'linkLbl'
      }, PT.cli.shortIf(l.a.port)));
      gLinks.appendChild(sEl('text', {
        x: b.x - ux * 48, y: b.y - uy * 48 - 6, class: 'linkLbl'
      }, PT.cli.shortIf(l.b.port)));
    });

    // ---- dispositivos
    gNodes.innerHTML = '';
    S.list().forEach(d => {
      const g = sEl('g', {
        class: 'node'
          + (UI.selected && UI.selected.kind === 'dev' && UI.selected.id === d.id ? ' selected' : '')
          + (UI.pduFrom && UI.pduFrom.id === d.id ? ' pduSrc' : ''),
        transform: `translate(${d.x},${d.y})`, 'data-dev': d.id
      });
      const conflito = d.ports.some(p => p.ipConflict);
      g.innerHTML =
        `<circle class="selRing" r="34" fill="none" stroke="none"></circle>` +
        ICONS[d.type] +
        `<rect class="hitbox" x="-30" y="-28" width="60" height="56"></rect>` +
        `<text class="label" y="42">${U.esc(d.name)}</text>` +
        (conflito ? `<g class="confl"><circle cx="22" cy="-22" r="9" fill="#ef4444" stroke="#0b0f13"></circle>
           <text x="22" y="-18" text-anchor="middle" font-size="12" fill="#fff" font-weight="700">!</text></g>` : '');
      gNodes.appendChild(g);
    });
  }

  /**
   * Desenhado a cada quadro: os pacotes em trânsito nos cabos.
   * Cada quadro vira um "envelope" (como no Packet Tracer) com rastro,
   * e o cabo por onde ele passa fica aceso.
   */
  function renderPackets() {
    const list = PT.engine.inflight;
    gPkts.innerHTML = '';

    // cabos em uso ficam destacados enquanto houver quadro neles
    const ocupados = new Set(list.map(p => p.linkId));
    gLinks.querySelectorAll('line.link').forEach(ln => {
      ln.classList.toggle('busy', ocupados.has(ln.getAttribute('data-link')));
    });

    for (const p of list) {
      const a = S.dev(p.fromDev), b = S.dev(p.toDev);
      if (!a || !b) continue;
      const k = U.clamp(p.t / p.dur, 0, 1);
      const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;

      // rastro: pedaço do caminho já percorrido, logo atrás do envelope
      const kr = Math.max(0, k - 0.16);
      gPkts.appendChild(sEl('line', {
        x1: a.x + (b.x - a.x) * kr, y1: a.y + (b.y - a.y) * kr, x2: x, y2: y,
        class: 'pktTrail', stroke: p.color
      }));

      const g = sEl('g', { class: 'pktG', transform: `translate(${x},${y})` });
      // envelope: corpo + aba
      g.appendChild(sEl('rect', {
        x: -12, y: -8, width: 24, height: 16, rx: 2, fill: p.color, class: 'pkt'
      }));
      g.appendChild(sEl('path', {
        d: 'M-12,-8 L0,1 L12,-8', fill: 'none', class: 'pktFlap'
      }));
      g.appendChild(sEl('text', { x: 0, y: -13, class: 'pktLbl' }, p.label));
      gPkts.appendChild(g);
    }
  }

  function drawRubber(to) {
    gOver.innerHTML = '';
    if (!UI.cableStart || !to) return;
    const d = UI.cableStart.dev;
    gOver.appendChild(sEl('line', { x1: d.x, y1: d.y, x2: to.x, y2: to.y, class: 'rubber' }));
  }

  /* ------------------------------------------------------------- interação */
  let drag = null, pan = null;

  function devAt(evt) {
    const g = evt.target.closest ? evt.target.closest('[data-dev]') : null;
    return g ? S.dev(g.getAttribute('data-dev')) : null;
  }
  function linkAt(evt) {
    const g = evt.target.closest ? evt.target.closest('[data-link]') : null;
    return g ? S.links[g.getAttribute('data-link')] : null;
  }

  function onCanvasDown(e) {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {   // pan
      pan = { sx: e.clientX, sy: e.clientY, vx: UI.view.x, vy: UI.view.y };
      e.preventDefault();
      return;
    }
    if (UI.tool !== 'select') return;
    const d = devAt(e);
    if (d) {
      const p = pt(e);
      drag = { dev: d, dx: d.x - p.x, dy: d.y - p.y, moved: false };
      select({ kind: 'dev', id: d.id });
    }
  }

  function onCanvasMove(e) {
    if (pan) {
      const r = svg.getBoundingClientRect();
      UI.view.x = pan.vx - (e.clientX - pan.sx) / r.width * UI.view.w;
      UI.view.y = pan.vy - (e.clientY - pan.sy) / r.height * UI.view.h;
      applyView();
      return;
    }
    if (drag) {
      const p = pt(e);
      drag.dev.x = Math.round(p.x + drag.dx);
      drag.dev.y = Math.round(p.y + drag.dy);
      drag.moved = true;
      render();
      return;
    }
    if (UI.cableStart) drawRubber(pt(e));
  }

  function onCanvasUp() { pan = null; if (drag) { drag = null; autosave(); } }

  function onCanvasClick(e) {
    const p = pt(e);
    // inserir dispositivo
    if (UI.armedType) {
      const d = M.createDevice(UI.armedType, p.x, p.y);
      UI.armedType = null;
      doc.querySelectorAll('.palItem').forEach(i => i.classList.remove('armed'));
      render(); setHint(); autosave();
      PT.engine.log(d, 'info', `${d.model} adicionado à topologia`);
      return;
    }
    const dev = devAt(e), lnk = linkAt(e);

    if (UI.tool === 'delete') {
      if (dev) { M.removeDevice(dev.id); PT.engine.topologyChanged(); }
      else if (lnk) { M.removeLink(lnk.id); PT.engine.topologyChanged(); }
      UI.selected = null; render(); autosave();
      return;
    }

    if (UI.tool === 'cable') {
      if (!dev) return;
      openPortMenu(dev, e.clientX, e.clientY);
      return;
    }

    if (UI.tool === 'pdu') {
      if (!dev) { UI.pduFrom = null; render(); setHint(); return; }
      if (!UI.pduFrom) { UI.pduFrom = dev; render(); setHint(); return; }
      const origem = UI.pduFrom;
      UI.pduFrom = null;
      sendPdu(origem, dev);
      render(); setHint();
      return;
    }

    if (!dev && !lnk) select(null);
    else if (lnk && !dev) select({ kind: 'link', id: lnk.id });
  }

  function onCanvasDblClick(e) {
    // o alvo do dblclick pode ser a raiz do SVG (os dois cliques caíram em nós
    // diferentes), por isso o fallback para o dispositivo selecionado
    const d = devAt(e) || (UI.selected && UI.selected.kind === 'dev' ? S.dev(UI.selected.id) : null);
    if (d) openDeviceWindow(d);
  }

  function select(sel) {
    UI.selected = sel;
    updateSelection();       // sem re-render: preserva os nós para o dblclick
    setHint();
  }

  function updateSelection() {
    const sel = UI.selected;
    gNodes.querySelectorAll('.node').forEach(g => {
      g.classList.toggle('selected', !!sel && sel.kind === 'dev' && sel.id === g.getAttribute('data-dev'));
    });
  }

  function setHint(msg) {
    if (msg) { hint.textContent = msg; return; }
    if (UI.armedType) { hint.textContent = `Clique na área de trabalho para inserir: ${M.DEVICE_DEFS[UI.armedType].label}`; return; }
    if (UI.tool === 'cable') {
      hint.textContent = UI.cableStart
        ? `Cabo ${cableName(UI.cable)}: origem ${UI.cableStart.dev.name} ${UI.cableStart.port.name} — clique no destino`
        : `Ferramenta Cabo (${cableName(UI.cable)}): clique no primeiro dispositivo`;
      return;
    }
    if (UI.tool === 'delete') { hint.textContent = 'Ferramenta Excluir: clique num dispositivo ou cabo'; return; }
    if (simAtivo() && UI.tool !== 'pdu' && !UI.selected) {
      hint.textContent = 'Modo simulação: cada clique em "Próximo" avança um salto. ' +
        'Clique num evento da lista para ver o PDU.';
      return;
    }
    if (UI.tool === 'pdu') {
      hint.textContent = UI.pduFrom
        ? `Pacote simples: origem ${UI.pduFrom.name} — clique no dispositivo de destino (Esc cancela)`
        : 'Ferramenta Pacote: clique no dispositivo de origem';
      return;
    }
    const sel = UI.selected;
    if (sel && sel.kind === 'dev') {
      const d = S.dev(sel.id);
      if (d) {
        const ips = d.ports.filter(p => p.ip).map(p => `${PT.cli.shortIf(p.name)} ${p.ip}/${U.maskToPrefix(p.mask)}${p.ipConflict ? ' ⚠DUPLICADO' : ''}`).join('  ');
        hint.textContent = `${d.name} (${d.model})  ${ips || 'sem IP configurado'} — duplo clique para configurar`;
        return;
      }
    }
    if (sel && sel.kind === 'link') {
      const l = S.links[sel.id];
      if (l) {
        const e = M.linkEnds(l);
        hint.textContent = `Cabo ${cableName(l.cable)}: ${e.da.name} ${l.a.port} ↔ ${e.db.name} ${l.b.port} — ${M.linkUp(l) ? 'ativo' : linkProblem(l)}`;
        return;
      }
    }
    hint.textContent = 'Arraste para mover • roda do mouse = zoom • Shift+arrastar = mover a tela • duplo clique = configurar';
  }

  function cableName(c) {
    return { auto: 'automático', straight: 'cobre direto', crossover: 'cobre crossover', serial: 'serial' }[c] || c;
  }

  function linkProblem(l) {
    const e = M.linkEnds(l);
    if (!M.cableOk(l)) return `cabo incorreto (o correto seria ${cableName(l.cable === 'serial' ? 'serial' : M.cableRequired(e.da, e.db))})`;
    if (e.pa.shutdown || e.pb.shutdown) return 'interface administrativamente desligada (use "no shutdown")';
    if (l.cable === 'serial') return 'falta "clock rate" no lado DCE';
    return 'inativo';
  }

  /* ------------------------------------------------------- menu de portas */
  let portMenu = null;
  function closePortMenu() { if (portMenu) { portMenu.remove(); portMenu = null; } }

  function openPortMenu(dev, cx, cy) {
    closePortMenu();
    const menu = el('div', { class: 'portMenu' });
    menu.appendChild(el('div', { class: 'hd' }, `${U.esc(dev.name)} — escolha a porta`));
    M.physicalPorts(dev).forEach(p => {
      const busy = !!p.link;
      const b = el('button', busy ? { disabled: 'disabled' } : {},
        `${U.esc(p.name)}${busy ? ' (ocupada)' : ''}`);
      b.onclick = () => { closePortMenu(); pickPort(dev, p); };
      menu.appendChild(b);
    });
    menu.style.left = cx + 'px';
    menu.style.top = cy + 'px';
    doc.body.appendChild(menu);
    portMenu = menu;
    setTimeout(() => doc.addEventListener('mousedown', outsideClose, { once: true }), 0);
    function outsideClose(ev) { if (portMenu && !portMenu.contains(ev.target)) closePortMenu(); }
  }

  function pickPort(dev, port) {
    if (!UI.cableStart) {
      UI.cableStart = { dev, port };
      setHint();
      return;
    }
    const a = UI.cableStart;
    UI.cableStart = null; drawRubber(null);
    const res = M.createLink(a.dev, a.port, dev, port, UI.cable);
    if (res.error) { toast(res.error, true); setHint(); return; }
    PT.engine.topologyChanged();
    const l = res.link;
    PT.engine.log(a.dev, 'info',
      `cabo ${cableName(l.cable)} ligado: ${a.dev.name} ${a.port.name} ↔ ${dev.name} ${port.name}` +
      (M.linkUp(l) ? '' : ` — enlace DOWN (${linkProblem(l)})`));
    if (!M.linkUp(l)) toast('Enlace criado, porém DOWN: ' + linkProblem(l), true);
    render(); setHint(); autosave();
  }

  /* ============================================================== pacote simples */

  /** Porta que o dispositivo usa como endereço de teste (a primeira ativa com IP). */
  function portaDeTeste(dev) {
    return dev.ports.find(p => p.ip && !p.ipConflict && M.isPortUp(dev, p))
      || dev.ports.find(p => p.ip)
      || null;
  }

  /** Um echo request (ICMP) de um dispositivo a outro — o "PDU simples" do Packet Tracer. */
  function sendPdu(src, dst) {
    if (src.id === dst.id) { toast('Escolha dois dispositivos diferentes.', true); return; }
    const pSrc = portaDeTeste(src), pDst = portaDeTeste(dst);
    if (!pSrc) { toast(`${src.name} não tem endereço IP configurado — configure antes de enviar o pacote.`, true); return; }
    if (!pDst) { toast(`${dst.name} não tem endereço IP configurado — configure antes de enviar o pacote.`, true); return; }

    const pdu = {
      n: ++pduSeq, src: src.name, dst: dst.name, dstIp: pDst.ip,
      estado: 'run', resultado: 'em curso', detalhe: `${pSrc.ip} → ${pDst.ip}`
    };
    UI.pdus.unshift(pdu);
    if (UI.pdus.length > 20) UI.pdus.pop();
    renderPduList();

    PT.engine.log(src, 'icmp', `pacote de teste: echo request para ${pDst.ip} (${dst.name})`);
    if (simAtivo()) toast('Modo simulação: clique em "Próximo" para o quadro andar um salto por vez.');
    else if (!PT.engine.running) toast('Simulação pausada — clique em "Continuar" para o pacote andar.');

    PT.engine.pingOnce(src, pDst.ip, {}, res => {
      if (res.ok) {
        pdu.estado = 'ok'; pdu.resultado = 'sucesso';
        pdu.detalhe = `resposta de ${res.from} em ${res.rtt} ms, TTL ${res.ttl}`;
      } else {
        pdu.estado = 'fail'; pdu.resultado = 'falha';
        pdu.detalhe = motivoDaFalha(res, pDst.ip);
      }
      renderPduList();
    });
  }

  function motivoDaFalha(res, dstIp) {
    if (res.type === 'unreachable-net') return `${res.from} respondeu: rede de destino inalcançável`;
    if (res.type === 'unreachable-host') return `${res.from} respondeu: host de destino inalcançável`;
    if (res.err === 'no-route') return 'sem rota para o destino (confira máscara e gateway padrão)';
    if (res.err === 'iface-down') return 'interface de saída sem enlace (link down)';
    if (res.err === 'arp') return `ninguém respondeu ao ARP de ${dstIp} (destino em outra rede ou desligado)`;
    return 'tempo esgotado — nenhuma resposta';
  }

  let pduSeq = 0;

  function renderPduList() {
    const box = doc.getElementById('pduBox');
    const list = doc.getElementById('pduList');
    if (!box || !list) return;
    if (!UI.pdus.length) { box.hidden = true; list.innerHTML = ''; return; }
    box.hidden = false;
    const rotulo = { run: 'em curso', ok: 'sucesso', fail: 'falha' };
    list.innerHTML =
      '<table><tr><th>#</th><th>Origem</th><th>Destino</th><th>Tipo</th><th>Resultado</th></tr>' +
      UI.pdus.map(p =>
        `<tr><td>${p.n}</td><td>${U.esc(p.src)}</td><td>${U.esc(p.dst)}</td><td>ICMP</td>` +
        `<td class="st ${p.estado}">${rotulo[p.estado]}</td></tr>` +
        `<tr><td></td><td class="det" colspan="4">${U.esc(p.detalhe)}</td></tr>`
      ).join('') + '</table>';
  }

  /* ============================================================ modo simulação */

  let autoTimer = null;

  function simAtivo() { return PT.engine.mode === 'sim'; }

  function setSimMode(on) {
    PT.engine.setMode(on ? 'sim' : 'realtime');
    pararAuto();
    $('#btnMode').textContent = on ? '⏱ Tempo real' : '🔬 Simulação';
    $('#btnMode').classList.toggle('active', on);
    $('#btnStep').hidden = !on;
    $('#btnAuto').hidden = !on;
    $('#btnPlay').disabled = on;
    if (!on) $('#btnPlay').textContent = PT.engine.running ? '⏸ Pausar' : '▶ Continuar';
    $('#simBox').hidden = !on;
    if (on) renderEvents();
    setHint();
  }

  function passo() {
    if (!simAtivo()) return;
    if (!PT.engine.stepOnce()) {
      pararAuto();
      toast('Nada pendente — envie um pacote (ferramenta 📨 Pacote) ou um ping.');
    }
  }

  function alternarAuto() {
    if (autoTimer) { pararAuto(); return; }
    if (!PT.engine.hasPending()) { toast('Nada pendente para avançar.'); return; }
    $('#btnAuto').textContent = '⏸ Auto';
    $('#btnAuto').classList.add('active');
    autoTimer = setInterval(() => {
      if (!simAtivo() || !PT.engine.stepOnce()) pararAuto();
    }, 900);
    passo();
  }

  function pararAuto() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    const b = $('#btnAuto');
    if (b) { b.textContent = '▶ Auto'; b.classList.remove('active'); }
  }

  /* ------------------------------------------------ lista de eventos */

  /** A que filtro este evento pertence (o mesmo agrupamento do log do rodapé). */
  function grupoDoEvento(tipo) {
    if (tipo === 'ARP') return 'arp';
    if (tipo === 'ICMP' || tipo === 'ERR') return 'icmp';
    if (tipo === 'DHCP') return 'dhcp';
    if (tipo === 'DNS') return 'dns';
    return 'outros';
  }

  function renderEvents() {
    const list = doc.getElementById('simList');
    if (!list) return;
    const evs = PT.engine.events.filter(ev => UI.simFilters[grupoDoEvento(ev.tipo)]);
    if (!evs.length) {
      list.innerHTML = '<div class="muted" style="padding:8px">' +
        (PT.engine.events.length
          ? 'Nenhum quadro nos protocolos marcados.'
          : 'Nenhum quadro ainda. Envie um pacote e clique em <b>Próximo</b>.') + '</div>';
      return;
    }
    list.innerHTML =
      '<table><tr><th>#</th><th>Tempo</th><th>De</th><th>Em</th><th>Tipo</th></tr>' +
      evs.map(ev =>
        `<tr class="ev" data-ev="${ev.n}">` +
        `<td class="mono">${ev.n}</td><td class="mono">${ev.t} ms</td>` +
        `<td>${U.esc(ev.de)} <span class="muted mono">${U.esc(PT.cli.shortIf(ev.dePorta))}</span></td>` +
        `<td>${U.esc(ev.em)} <span class="muted mono">${U.esc(PT.cli.shortIf(ev.emPorta))}</span></td>` +
        `<td><span class="dot" style="background:${ev.cor}"></span> ${ev.tipo}</td></tr>`
      ).join('') + '</table>';
    list.querySelectorAll('tr.ev').forEach(tr => {
      tr.onclick = () => {
        const ev = PT.engine.events.find(x => x.n === +tr.dataset.ev);
        if (ev) openPduWindow(ev);
      };
    });
    list.scrollTop = list.scrollHeight;
  }

  /* ------------------------------------------------ PDU camada por camada */
  const ICMP_NOMES = {
    'echo-request': 'Echo Request (ping)',
    'echo-reply': 'Echo Reply (resposta do ping)',
    'time-exceeded': 'Time Exceeded (TTL zerou)',
    'unreachable-net': 'Destination Unreachable — rede',
    'unreachable-host': 'Destination Unreachable — host'
  };

  function camada(titulo, linhas) {
    const corpo = linhas.filter(Boolean)
      .map(([k, v]) => `<tr><td>${U.esc(k)}</td><td class="v">${U.esc(v === undefined || v === null || v === '' ? '—' : v)}</td></tr>`)
      .join('');
    return `<div class="pduLayer"><h4>${U.esc(titulo)}</h4><table>${corpo}</table></div>`;
  }

  function pduHtml(ev) {
    const f = ev.frame;
    let html = camada('Camada 2 — Ethernet', [
      ['MAC de origem', f.src],
      ['MAC de destino', f.dst + (U.isBcastMac(f.dst) ? '  (broadcast)' : '')],
      ['Tipo', f.type === 'arp' ? 'ARP (0x0806)' : 'IPv4 (0x0800)'],
      f.vlan ? ['Etiqueta VLAN (802.1Q)', f.vlan] : null
    ]);

    if (f.type === 'arp') {
      const a = f.arp;
      html += camada('Camada 3 — ARP', [
        ['Operação', a.op === 'request' ? 'request — "quem tem este IP?"' : 'reply — "este IP está neste MAC"'],
        ['MAC do remetente', a.senderMac],
        ['IP do remetente', a.senderIp],
        ['MAC procurado', a.targetMac],
        ['IP procurado', a.targetIp]
      ]);
      return html;
    }

    const ip = f.ip || {};
    html += camada('Camada 3 — IPv4', [
      ['IP de origem', ip.src || '0.0.0.0'],
      ['IP de destino', ip.dst + (U.isBroadcastIp(ip.dst) ? '  (broadcast)' : '')],
      ['TTL', ip.ttl],
      ['Protocolo', (ip.proto || '').toUpperCase()]
    ]);

    if (ip.proto === 'icmp') {
      const ic = ip.icmp || {};
      html += camada('Camada 4 — ICMP', [
        ['Tipo', ICMP_NOMES[ic.type] || ic.type],
        ic.id !== undefined && ic.id !== null ? ['Identificador', ic.id] : null,
        ic.seq !== undefined && ic.seq !== null ? ['Sequência', ic.seq] : null,
        ic.size ? ['Dados', ic.size + ' bytes'] : null,
        ic.orig ? ['Pacote que causou o erro', `${ic.orig.src} → ${ic.orig.dst}`] : null
      ]);
    } else if (ip.proto === 'udp') {
      const u = ip.udp || {};
      html += camada('Camada 4 — UDP', [
        ['Porta de origem', u.sport],
        ['Porta de destino', u.dport],
        ['Aplicação', (u.app || '').toUpperCase()]
      ]);
      if (u.app === 'dhcp') {
        html += camada('Aplicação — DHCP', [
          ['Mensagem', (u.op || '').toUpperCase()],
          ['Transação (xid)', u.xid],
          ['MAC do cliente', u.mac],
          u.requested ? ['Endereço pedido', u.requested] : null,
          u.yiaddr ? ['Endereço oferecido', u.yiaddr] : null,
          u.mask ? ['Máscara', u.mask] : null,
          u.gw ? ['Gateway', u.gw] : null,
          u.dns ? ['Servidor DNS', u.dns] : null,
          u.server ? ['Servidor DHCP', u.server] : null
        ]);
      } else if (u.app === 'dns') {
        html += camada('Aplicação — DNS', [
          ['Mensagem', u.op === 'query' ? 'query (pergunta)' : 'reply (resposta)'],
          ['Nome', u.name],
          ['Transação (xid)', u.xid],
          u.op === 'reply' ? ['Resposta', u.ip || 'nome não encontrado'] : null
        ]);
      }
    }
    return html;
  }

  function openPduWindow(ev) {
    const w = makeWindow(`PDU #${ev.n} — ${ev.tipo}`, 'pdu');
    w.body.innerHTML =
      `<div class="hintbox">Quadro de <b>${U.esc(ev.de)}</b> (${U.esc(ev.dePorta)}) para ` +
      `<b>${U.esc(ev.em)}</b> (${U.esc(ev.emPorta)}), no instante ${ev.t} ms da simulação. ` +
      'É o que passaria no cabo — de fora para dentro, camada por camada.</div>' + pduHtml(ev);
  }

  /* ==================================================================== janelas */
  function openDeviceWindow(dev) {
    const existing = UI.windows.find(w => w.dev.id === dev.id);
    if (existing) { existing.root.style.zIndex = ++zTop; return; }

    const tabs = (dev.type === 'router' || dev.type === 'switch')
      ? [['config', 'Config'], ['cli', 'CLI'], ['tables', 'Tabelas']]
      : (dev.type === 'server'
        ? [['config', 'Config'], ['services', 'Serviços'], ['desktop', 'Desktop']]
        : [['config', 'Config'], ['desktop', 'Desktop']]);

    const root = el('div', { class: 'win' });
    root.style.left = '260px'; root.style.top = '90px';
    root.style.zIndex = ++zTop;
    root.innerHTML =
      `<div class="winHead"><span class="ttl"></span><span class="muted mdl"></span><button class="x">✕</button></div>
       <div class="winTabs"></div><div class="winBody"></div>`;
    const head = root.querySelector('.winHead');
    const tabBar = root.querySelector('.winTabs');
    const body = root.querySelector('.winBody');

    const w = { dev, root, body, tab: tabs[0][0], render: null };
    UI.windows.push(w);

    tabs.forEach(([id, label]) => {
      const b = el('button', {}, label);
      b.onclick = () => { w.tab = id; paint(); };
      b.dataset.tab = id;
      tabBar.appendChild(b);
    });

    root.querySelector('.x').onclick = () => { root.remove(); UI.windows = UI.windows.filter(x => x !== w); };
    dragWindow(root, head);
    doc.getElementById('modalRoot').appendChild(root);

    function paint() {
      root.querySelector('.ttl').textContent = dev.name;
      root.querySelector('.mdl').textContent = dev.model;
      tabBar.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === w.tab));
      body.innerHTML = '';
      if (w.tab === 'config') tabConfig(dev, body, paint);
      else if (w.tab === 'cli') tabTerminal(dev, body, 'ios');
      else if (w.tab === 'desktop') tabDesktop(dev, body, paint);
      else if (w.tab === 'services') tabServices(dev, body, paint);
      else if (w.tab === 'tables') tabTables(dev, body);
    }
    w.render = () => { if (w.tab !== 'cli' && w.tab !== 'desktop') paint(); else root.querySelector('.ttl').textContent = dev.name; };
    paint();
  }

  let zTop = 50;

  /** Janela genérica (usada pelo módulo de laboratório e pela ajuda). */
  function makeWindow(title, cls) {
    const root = el('div', { class: 'win ' + (cls || '') });
    root.style.left = '240px'; root.style.top = '70px'; root.style.zIndex = ++zTop;
    root.innerHTML = `<div class="winHead"><span class="ttl"></span><button class="x">✕</button></div><div class="winBody"></div>`;
    root.querySelector('.ttl').textContent = title;
    const api = {
      root,
      body: root.querySelector('.winBody'),
      close: () => root.remove(),
      setTitle: t => { root.querySelector('.ttl').textContent = t; }
    };
    root.querySelector('.x').onclick = () => api.close();
    dragWindow(root, root.querySelector('.winHead'));
    doc.getElementById('modalRoot').appendChild(root);
    return api;
  }

  function elDiv(cls, html) { return el('div', { class: cls }, html); }
  function elBtn(label, onClick) { const b = el('button', {}, U.esc(label)); b.onclick = onClick; return b; }

  function dragWindow(root, handle) {
    handle.addEventListener('mousedown', e => {
      if (e.target.classList.contains('x')) return;
      root.style.zIndex = ++zTop;
      const sx = e.clientX, sy = e.clientY;
      const ox = root.offsetLeft, oy = root.offsetTop;
      const mv = ev => { root.style.left = (ox + ev.clientX - sx) + 'px'; root.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; };
      const up = () => { doc.removeEventListener('mousemove', mv); doc.removeEventListener('mouseup', up); };
      doc.addEventListener('mousemove', mv); doc.addEventListener('mouseup', up);
    });
  }

  /* ------------------------------------------------------------ aba Config */
  function tabConfig(dev, body, repaint) {
    const isHost = dev.klass === 'host';

    if (PT.lab) {
      const bar = el('div', { class: 'formRow' });
      bar.appendChild(elBtn('🔧 Comandos reais (fazer isto no laboratório)', () => PT.lab.openCommands(dev)));
      bar.appendChild(el('span', { class: 'muted' },
        isHost ? 'Gera os comandos netsh / GUI do Windows e nmcli do Linux equivalentes a esta configuração.'
          : 'Gera o script IOS pronto para colar no console do equipamento real.'));
      body.appendChild(bar);
    }

    const fs1 = el('fieldset', {}, '<legend>Identificação</legend>');
    fs1.appendChild(row('Nome do dispositivo', inputText(dev.name, v => {
      if (!v.trim()) return;
      dev.name = v.trim(); render(); refreshWindows(); autosave();
    })));
    body.appendChild(fs1);

    if (isHost) {
      const fs = el('fieldset', {}, '<legend>Configuração IP</legend>');
      const modeWrap = el('div', { class: 'formRow' });
      modeWrap.innerHTML = `<label>Atribuição</label>
        <label style="width:auto"><input type="radio" name="ipmode" value="static"> Estático</label>
        <label style="width:auto"><input type="radio" name="ipmode" value="dhcp"> DHCP</label>`;
      fs.appendChild(modeWrap);
      modeWrap.querySelectorAll('input').forEach(r => {
        r.checked = (r.value === 'dhcp') === !!dev.dhcpMode;
        r.onchange = () => {
          dev.dhcpMode = r.value === 'dhcp';
          if (dev.dhcpMode) PT.engine.dhcpStart(dev, res => {
            toast(res.ok ? `DHCP: endereço ${res.ip} obtido` : 'DHCP: nenhum servidor respondeu', !res.ok);
            repaint();
          });
          repaint();
        };
      });

      const p = dev.ports[0];
      fs.appendChild(row('Endereço IPv4', inputText(p.ip, v => setIp(dev, p, v), dev.dhcpMode)));
      fs.appendChild(row('Máscara', inputText(p.mask, v => setMask(dev, p, v), dev.dhcpMode)));
      fs.appendChild(row('Gateway padrão', inputText(dev.gateway, v => { dev.gateway = v.trim(); commit(); }, dev.dhcpMode)));
      fs.appendChild(row('Servidor DNS', inputText(dev.dns, v => { dev.dns = v.trim(); commit(); }, dev.dhcpMode)));
      if (p.ipConflict) {
        fs.appendChild(el('div', { class: 'alertbox' },
          `⚠ <b>Conflito de endereço IP:</b> ${U.esc(p.ip)} já está em uso por outro equipamento da rede. ` +
          'Enquanto isso o endereço fica desativado nesta interface — troque o IP para um livre.'));
      }
      fs.appendChild(el('div', { class: 'muted' },
        `MAC: <span style="font-family:var(--mono)">${p.mac}</span> — porta ${p.name} — ` +
        `<span class="pill ${M.isPortUp(dev, p) ? 'up' : 'down'}">${M.isPortUp(dev, p) ? 'link up' : 'link down'}</span>`));
      body.appendChild(fs);
      return;
    }

    // ------- roteador / switch: lista de interfaces
    const fs = el('fieldset', {}, '<legend>Interfaces</legend>');
    const wrap = el('div', { class: 'ifList' });
    const names = el('div', { class: 'names' });
    const detail = el('div', { class: 'detail' });
    let cur = dev._uiIf && M.getPort(dev, dev._uiIf) ? dev._uiIf : dev.ports[0].name;

    dev.ports.forEach(p => {
      const d = el('div', {}, `${PT.cli.shortIf(p.name)} <span class="pill ${M.isPortUp(dev, p) ? 'up' : 'down'}">${M.isPortUp(dev, p) ? 'up' : 'down'}</span>`);
      if (p.name === cur) d.classList.add('sel');
      d.onclick = () => { dev._uiIf = p.name; repaint(); };
      names.appendChild(d);
    });

    const p = M.getPort(dev, cur);
    detail.appendChild(el('div', { class: 'hintbox' },
      `<b>${U.esc(p.name)}</b> — ${p.kind === 'serial' ? 'serial (WAN)' : p.kind === 'vlan' ? 'interface virtual de gerência' : 'ethernet'}<br>
       MAC: <span style="font-family:var(--mono)">${p.mac || '—'}</span>`));

    const onOff = el('div', { class: 'formRow' });
    onOff.innerHTML = '<label>Status da porta</label>';
    const chk = el('input', { type: 'checkbox' });
    chk.checked = !p.shutdown;
    chk.onchange = () => { p.shutdown = !chk.checked; commit(); repaint(); };
    onOff.appendChild(chk);
    onOff.appendChild(el('span', { class: 'muted' }, chk.checked ? ' ligada (no shutdown)' : ' desligada (shutdown)'));
    detail.appendChild(onOff);

    detail.appendChild(row('Endereço IPv4', inputText(p.ip, v => setIp(dev, p, v))));
    detail.appendChild(row('Máscara', inputText(p.mask, v => setMask(dev, p, v))));

    if (dev.type === 'switch' && p.kind === 'copper') {
      const sel = el('select');
      sel.innerHTML = '<option value="access">access</option><option value="trunk">trunk</option>';
      sel.value = p.mode;
      sel.onchange = () => { p.mode = sel.value; commit(); repaint(); };
      detail.appendChild(row('Modo switchport', sel));

      const vsel = el('select');
      Object.keys(dev.vlans).forEach(v => vsel.appendChild(el('option', { value: v }, `${v} — ${dev.vlans[v]}`)));
      vsel.value = p.vlan;
      vsel.onchange = () => { p.vlan = +vsel.value; commit(); repaint(); };
      if (p.mode === 'access') detail.appendChild(row('VLAN de acesso', vsel));
    }
    if (p.kind === 'serial') {
      const l = M.linkOf(p);
      const isDce = l && ((l.dce === 'a' && l.a.dev === dev.id && l.a.port === p.name) || (l.dce === 'b' && l.b.dev === dev.id && l.b.port === p.name));
      detail.appendChild(row('Lado do cabo', el('span', { class: 'muted' }, l ? (isDce ? 'DCE (precisa de clock rate)' : 'DTE') : 'sem cabo')));
      if (isDce) detail.appendChild(row('Clock rate', inputText(p.clockRate || '', v => { p.clockRate = parseInt(v, 10) || 0; commit(); repaint(); })));
    }
    detail.appendChild(row('Descrição', inputText(p.description, v => { p.description = v; autosave(); })));

    wrap.appendChild(names); wrap.appendChild(detail);
    fs.appendChild(wrap);
    body.appendChild(fs);

    if (dev.type === 'router') body.appendChild(routeEditor(dev, repaint));
    if (dev.type === 'switch') body.appendChild(vlanEditor(dev, repaint));

    function commitLocal() { commit(); }
    void commitLocal;
  }

  function setIp(dev, port, v) {
    v = v.trim();
    if (v && !U.isValidIp(v)) { toast('Endereço IP inválido: ' + v, true); return; }
    const mask = port.mask || (v ? U.classfulMask(v) : '');
    const problema = v ? U.hostAddrProblem(v, mask) : null;
    if (problema) {
      toast(problema === 'rede'
        ? `${v} é o endereço da própria sub-rede com a máscara ${mask} — não pode ser usado num host. Refaça o cálculo.`
        : `${v} é o endereço de broadcast da sub-rede com a máscara ${mask} — não pode ser usado num host. Refaça o cálculo.`, true);
      return;
    }
    port.ip = v;
    port.ipConflict = false;
    if (v && !port.mask) port.mask = U.classfulMask(v);
    commit();
  }

  /** Troca de máscara: revalida o endereço já configurado. */
  function setMask(dev, port, v) {
    v = v.trim();
    if (v && !U.isValidMask(v)) { toast('Máscara inválida: ' + v, true); return; }
    const problema = port.ip && v ? U.hostAddrProblem(port.ip, v) : null;
    if (problema) {
      toast(`Com a máscara ${v}, o endereço ${port.ip} passa a ser o endereço de ` +
        (problema === 'rede' ? 'sub-rede' : 'broadcast') + ' — corrija o endereço do host primeiro.', true);
      return;
    }
    port.mask = v;
    port.ipConflict = false;
    commit();
  }

  function commit() {
    PT.engine.topologyChanged();
    render(); setHint(); refreshWindows(); autosave();
  }

  function row(label, control) {
    const r = el('div', { class: 'formRow' });
    r.appendChild(el('label', {}, U.esc(label)));
    r.appendChild(control);
    return r;
  }

  function inputText(value, onChange, disabled) {
    const i = el('input', { type: 'text', value: value === undefined || value === null ? '' : value });
    if (disabled) i.disabled = true;
    i.value = value || '';
    i.onchange = () => onChange(i.value);
    i.onkeydown = e => { if (e.key === 'Enter') i.blur(); };
    return i;
  }

  function routeEditor(dev, repaint) {
    const fs = el('fieldset', {}, '<legend>Rotas estáticas</legend>');
    const tbl = el('table', { class: 'grid' },
      '<tr><th class="mono">Rede</th><th class="mono">Máscara</th><th class="mono">Próximo salto / interface</th><th></th></tr>');
    (dev.staticRoutes || []).forEach((r, i) => {
      const tr = el('tr', {}, `<td class="mono">${r.net}</td><td class="mono">${r.mask}</td><td class="mono">${r.nh || r.iface}</td>`);
      const td = el('td'); const b = el('button', {}, 'remover');
      b.onclick = () => { dev.staticRoutes.splice(i, 1); commit(); repaint(); };
      td.appendChild(b); tr.appendChild(td); tbl.appendChild(tr);
    });
    fs.appendChild(tbl);
    const f = el('div', { class: 'formRow' });
    const net = el('input', { type: 'text', placeholder: '192.168.3.0' });
    const mask = el('input', { type: 'text', placeholder: '255.255.255.0' });
    const nh = el('input', { type: 'text', placeholder: '10.0.0.2' });
    const add = el('button', {}, 'Adicionar rota');
    add.onclick = () => {
      if (!U.isValidIp(net.value) || !U.isValidMask(mask.value) || !U.isValidIp(nh.value)) { toast('Preencha rede, máscara e próximo salto válidos', true); return; }
      dev.staticRoutes.push({ net: U.networkOf(net.value, mask.value), mask: mask.value, nh: nh.value, iface: null });
      commit(); repaint();
    };
    [net, mask, nh, add].forEach(x => f.appendChild(x));
    fs.appendChild(f);
    fs.appendChild(el('div', { class: 'muted' }, 'Equivalente no CLI: <span style="font-family:var(--mono)">ip route &lt;rede&gt; &lt;máscara&gt; &lt;próximo-salto&gt;</span>'));
    return fs;
  }

  function vlanEditor(dev, repaint) {
    const fs = el('fieldset', {}, '<legend>VLANs</legend>');
    const tbl = el('table', { class: 'grid' }, '<tr><th>ID</th><th>Nome</th><th>Portas</th><th></th></tr>');
    Object.keys(dev.vlans).sort((a, b) => a - b).forEach(id => {
      const ports = M.physicalPorts(dev).filter(p => p.mode === 'access' && p.vlan == id).map(p => PT.cli.shortIf(p.name)).join(', ');
      const tr = el('tr', {}, `<td>${id}</td><td>${U.esc(dev.vlans[id])}</td><td class="mono">${ports || '—'}</td>`);
      const td = el('td');
      if (id != 1) {
        const b = el('button', {}, 'remover');
        b.onclick = () => {
          delete dev.vlans[id];
          M.physicalPorts(dev).forEach(p => { if (p.vlan == id) p.vlan = 1; });
          commit(); repaint();
        };
        td.appendChild(b);
      }
      tr.appendChild(td); tbl.appendChild(tr);
    });
    fs.appendChild(tbl);
    const f = el('div', { class: 'formRow' });
    const id = el('input', { type: 'text', placeholder: '10' });
    const nm = el('input', { type: 'text', placeholder: 'VENDAS' });
    const add = el('button', {}, 'Criar VLAN');
    add.onclick = () => {
      const n = parseInt(id.value, 10);
      if (!n || n < 1 || n > 4094) { toast('ID de VLAN inválido', true); return; }
      dev.vlans[n] = nm.value.trim() || ('VLAN' + String(n).padStart(4, '0'));
      commit(); repaint();
    };
    [id, nm, add].forEach(x => f.appendChild(x));
    fs.appendChild(f);
    return fs;
  }

  /* ---------------------------------------------------------- aba Serviços */
  function tabServices(dev, body, repaint) {
    const d = dev.services.dhcp;
    const fs = el('fieldset', {}, '<legend>Servidor DHCP</legend>');
    const on = el('input', { type: 'checkbox' });
    on.checked = d.on;
    on.onchange = () => { d.on = on.checked; autosave(); repaint(); };
    fs.appendChild(row('Serviço ativo', on));
    fs.appendChild(row('IP inicial do pool', inputText(d.start, v => { d.start = v.trim(); autosave(); })));
    fs.appendChild(row('Máscara', inputText(d.mask, v => { d.mask = v.trim(); autosave(); })));
    fs.appendChild(row('Gateway entregue', inputText(d.gw, v => { d.gw = v.trim(); autosave(); })));
    fs.appendChild(row('DNS entregue', inputText(d.dns, v => { d.dns = v.trim(); autosave(); })));
    fs.appendChild(row('Máx. de endereços', inputText(d.count, v => { d.count = parseInt(v, 10) || 50; autosave(); })));
    const leases = Object.keys(d.leases);
    if (leases.length) {
      const t = el('table', { class: 'grid' }, '<tr><th class="mono">MAC</th><th class="mono">IP concedido</th></tr>');
      leases.forEach(m => t.appendChild(el('tr', {}, `<td class="mono">${m}</td><td class="mono">${d.leases[m]}</td>`)));
      fs.appendChild(t);
    }
    body.appendChild(fs);

    const n = dev.services.dns;
    const fs2 = el('fieldset', {}, '<legend>Servidor DNS</legend>');
    const on2 = el('input', { type: 'checkbox' });
    on2.checked = n.on;
    on2.onchange = () => { n.on = on2.checked; autosave(); repaint(); };
    fs2.appendChild(row('Serviço ativo', on2));
    const t2 = el('table', { class: 'grid' }, '<tr><th>Nome</th><th class="mono">Endereço</th><th></th></tr>');
    Object.keys(n.records).forEach(k => {
      const tr = el('tr', {}, `<td>${U.esc(k)}</td><td class="mono">${n.records[k]}</td>`);
      const td = el('td'); const b = el('button', {}, 'remover');
      b.onclick = () => { delete n.records[k]; autosave(); repaint(); };
      td.appendChild(b); tr.appendChild(td); t2.appendChild(tr);
    });
    fs2.appendChild(t2);
    const f = el('div', { class: 'formRow' });
    const nm = el('input', { type: 'text', placeholder: 'www.exemplo.com' });
    const ip = el('input', { type: 'text', placeholder: '192.168.2.100' });
    const add = el('button', {}, 'Adicionar registro');
    add.onclick = () => {
      if (!nm.value.trim() || !U.isValidIp(ip.value)) { toast('Informe nome e IP válidos', true); return; }
      n.records[nm.value.trim().toLowerCase()] = ip.value.trim();
      autosave(); repaint();
    };
    [nm, ip, add].forEach(x => f.appendChild(x));
    fs2.appendChild(f);
    body.appendChild(fs2);
  }

  /* ------------------------------------------------------------ aba Tabelas */
  function tabTables(dev, body) {
    if (dev.type === 'switch') {
      const fs = el('fieldset', {}, '<legend>Tabela de endereços MAC</legend>');
      const t = el('table', { class: 'grid' }, '<tr><th>VLAN</th><th class="mono">MAC</th><th>Porta</th><th>Tipo</th></tr>');
      const keys = Object.keys(dev.macTable);
      keys.forEach(m => t.appendChild(el('tr', {}, `<td>${dev.macTable[m].vlan}</td><td class="mono">${m}</td><td class="mono">${PT.cli.shortIf(dev.macTable[m].port)}</td><td>DYNAMIC</td>`)));
      if (!keys.length) t.appendChild(el('tr', {}, '<td colspan="4" class="muted">vazia — gere tráfego (ping) para o switch aprender</td>'));
      fs.appendChild(t);
      body.appendChild(fs);
    }
    const fs2 = el('fieldset', {}, '<legend>Tabela de roteamento</legend>');
    const t2 = el('table', { class: 'grid' }, '<tr><th>Código</th><th class="mono">Rede</th><th class="mono">Próximo salto</th><th>Interface</th></tr>');
    PT.engine.routes(dev).forEach(r => t2.appendChild(el('tr', {},
      `<td>${r.type}</td><td class="mono">${r.net}/${U.maskToPrefix(r.mask)}</td><td class="mono">${r.nh || 'conectada'}</td><td class="mono">${r.iface || '—'}</td>`)));
    fs2.appendChild(t2);
    body.appendChild(fs2);

    const fs3 = el('fieldset', {}, '<legend>Cache ARP</legend>');
    const t3 = el('table', { class: 'grid' }, '<tr><th class="mono">IP</th><th class="mono">MAC</th><th>Interface</th></tr>');
    const ks = Object.keys(dev.arp);
    ks.forEach(ip => t3.appendChild(el('tr', {}, `<td class="mono">${ip}</td><td class="mono">${dev.arp[ip].mac}</td><td class="mono">${dev.arp[ip].port}</td>`)));
    if (!ks.length) t3.appendChild(el('tr', {}, '<td colspan="3" class="muted">vazio</td>'));
    fs3.appendChild(t3);
    body.appendChild(fs3);
  }

  /* ------------------------------------------------------------ aba Desktop */
  function tabDesktop(dev, body, repaint) {
    const fs = el('fieldset', {}, '<legend>IP Configuration</legend>');
    const p = dev.ports[0];
    fs.appendChild(el('div', { class: 'hintbox' },
      'Configure aqui como no Packet Tracer, ou use o prompt abaixo: <span style="font-family:var(--mono)">ipconfig, ping, tracert, arp -a, nslookup</span>.'));
    fs.appendChild(row('Endereço IPv4', inputText(p.ip, v => { setIp(dev, p, v); repaint(); })));
    fs.appendChild(row('Máscara', inputText(p.mask, v => setMask(dev, p, v))));
    fs.appendChild(row('Gateway padrão', inputText(dev.gateway, v => { dev.gateway = v.trim(); commit(); })));
    fs.appendChild(row('Servidor DNS', inputText(dev.dns, v => { dev.dns = v.trim(); commit(); })));
    body.appendChild(fs);
    const fs2 = el('fieldset', {}, '<legend>Command Prompt</legend>');
    fs2.appendChild(makeTerminal(dev));
    body.appendChild(fs2);
  }

  function tabTerminal(dev, body) {
    body.appendChild(el('div', { class: 'hintbox' },
      'Terminal IOS. Experimente: <span style="font-family:var(--mono)">enable → configure terminal → interface g0/0 → ip address 192.168.1.1 255.255.255.0 → no shutdown</span>. Abreviações funcionam (<span style="font-family:var(--mono)">conf t</span>, <span style="font-family:var(--mono)">sh ip int br</span>). Digite <span style="font-family:var(--mono)">?</span> para ajuda do modo atual.'));
    body.appendChild(makeTerminal(dev));
  }

  /* ------------------------------------------------------------- terminal */
  function makeTerminal(dev) {
    const shell = PT.cli.createShell(dev);
    const box = el('div', { class: 'term' });
    const out = el('div', { class: 'termOut' });
    const inp = el('div', { class: 'termIn' });
    const ps = el('span', { class: 'ps' });
    const field = el('input', { type: 'text', spellcheck: 'false' });
    inp.appendChild(ps); inp.appendChild(field);
    box.appendChild(out); box.appendChild(inp);

    if (!dev._term) dev._term = [];
    if (!dev._term.length) {
      dev._term.push(dev.klass === 'host'
        ? 'NetSim — prompt de comando. Digite "help" para ver os comandos.\n'
        : `NetSim — console IOS de ${dev.name}. Digite "?" para ajuda.\n`);
    }
    out.textContent = dev._term.join('\n');

    const write = txt => {
      dev._term.push(String(txt));
      out.textContent = dev._term.join('\n');
      out.scrollTop = out.scrollHeight;
    };
    const setPrompt = () => { ps.textContent = shell.prompt(); };
    setPrompt();

    let busy = false, hist = dev._hist || (dev._hist = []), hi = hist.length;

    field.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !busy) {
        const line = field.value;
        field.value = '';
        write(shell.prompt() + line);
        if (line.trim()) { hist.push(line); hi = hist.length; }
        busy = true; field.disabled = true; ps.classList.add('busy');
        const ctx = {
          write,
          clear: () => { dev._term.length = 0; out.textContent = ''; },
          done: () => {
            busy = false; field.disabled = false; ps.classList.remove('busy');
            setPrompt(); field.focus();
            out.scrollTop = out.scrollHeight;
          }
        };
        try { shell.exec(line, ctx); } catch (err) { write('% erro interno: ' + err.message); ctx.done(); }
      } else if (e.key === 'ArrowUp') {
        if (hi > 0) { hi--; field.value = hist[hi] || ''; }
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        if (hi < hist.length - 1) { hi++; field.value = hist[hi] || ''; } else { hi = hist.length; field.value = ''; }
        e.preventDefault();
      }
    });
    box.addEventListener('click', () => field.focus());
    setTimeout(() => field.focus(), 30);
    return box;
  }

  function refreshWindows() { UI.windows.forEach(w => { if (w.render) w.render(); }); }

  /* ==================================================================== paleta */
  function initPalette() {
    const groups = { net: $('.palItems[data-group="net"]'), end: $('.palItems[data-group="end"]') };
    Object.keys(M.DEVICE_DEFS).forEach(type => {
      const def = M.DEVICE_DEFS[type];
      const it = el('div', { class: 'palItem', title: def.model },
        `<svg viewBox="-32 -28 64 56">${ICONS[type]}</svg><span>${def.label}</span>`);
      it.onclick = () => {
        const was = it.classList.contains('armed');
        doc.querySelectorAll('.palItem').forEach(i => i.classList.remove('armed'));
        UI.armedType = was ? null : type;
        if (!was) it.classList.add('armed');
        setTool('select', true);
        setHint();
      };
      groups[def.group].appendChild(it);
    });
  }

  function setTool(t, keepArmed) {
    UI.tool = t;
    if (!keepArmed) { UI.armedType = null; doc.querySelectorAll('.palItem').forEach(i => i.classList.remove('armed')); }
    UI.cableStart = null; drawRubber(null);
    UI.pduFrom = null;
    doc.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    svg.classList.remove('mode-cable', 'mode-delete', 'mode-pdu');
    if (t === 'cable') svg.classList.add('mode-cable');
    if (t === 'delete') svg.classList.add('mode-delete');
    if (t === 'pdu') svg.classList.add('mode-pdu');
    render(); setHint();
  }

  /* ==================================================================== log */
  function initLog() {
    const list = $('#logList');
    PT.engine.onLog = row => {
      if (!passFilter(row.kind)) return;
      const d = el('div', { class: 'logRow' },
        `<span class="t">${(row.t / 1000).toFixed(1)}s</span><span class="d">${U.esc(row.dev)}</span><span class="log-${row.kind}">${U.esc(row.text)}</span>`);
      list.appendChild(d);
      while (list.children.length > 300) list.firstChild.remove();
      list.scrollTop = list.scrollHeight;
    };
    $('#btnLogClear').onclick = () => { list.innerHTML = ''; PT.engine.logs.length = 0; };
    const map = { logArp: 'arp', logIcmp: 'icmp', logSw: 'sw', logOther: 'other' };
    Object.keys(map).forEach(id => {
      $('#' + id).onchange = e => { UI.filters[map[id]] = e.target.checked; };
    });
  }

  function passFilter(kind) {
    if (kind === 'arp') return UI.filters.arp;
    if (kind === 'icmp' || kind === 'route' || kind === 'err') return UI.filters.icmp;
    if (kind === 'switch') return UI.filters.sw;
    return UI.filters.other;
  }

  /* ============================================================ persistência */
  const LS_KEY = 'netsim.autosave.v1';
  let saveTimer = null;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify(M.serialize())); } catch (e) { /* quota */ }
    }, 400);
  }
  function restore() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      M.load(JSON.parse(raw));
      return S.list().length > 0;
    } catch (e) { return false; }
  }

  function saveFile() {
    const blob = new Blob([JSON.stringify(M.serialize(), null, 2)], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'topologia-netsim.json';
    doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('Topologia salva em topologia-netsim.json');
  }

  function loadFile(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        M.load(JSON.parse(fr.result));
        PT.engine.reset();
        closeAllWindows();
        render(); fitView(); setHint(); autosave();
        toast('Topologia carregada');
      } catch (e) { toast('Arquivo inválido: ' + e.message, true); }
    };
    fr.readAsText(file);
  }

  function closeAllWindows() {
    UI.windows.forEach(w => w.root.remove());
    UI.windows = [];
  }

  function clearAll() {
    if (!confirm('Apagar toda a topologia?')) return;
    S.devices = {}; S.links = {}; S.counters = {};
    PT.engine.reset(); closeAllWindows();
    $('#logList').innerHTML = '';
    UI.pdus = []; UI.pduFrom = null; renderPduList();
    PT.engine.clearEvents(); renderEvents();
    render(); setHint(); autosave();
  }

  /* ================================================================== ajuda */
  function openHelp() {
    const root = el('div', { class: 'win help' });
    root.style.left = '300px'; root.style.top = '70px'; root.style.zIndex = ++zTop;
    root.innerHTML = `
      <div class="winHead"><span class="ttl">Como usar o NetSim</span><button class="x">✕</button></div>
      <div class="winBody help">
        <h3>1. Montar a topologia</h3>
        <ul>
          <li>Clique num dispositivo da paleta e depois na área de trabalho para inseri-lo.</li>
          <li>Ferramenta <b>Cabo</b>: clique no primeiro dispositivo, escolha a porta, clique no segundo e escolha a porta.</li>
          <li>Regras reais de cabeamento: <b>direto</b> entre equipamentos diferentes (PC↔Switch, Router↔Switch) e
              <b>crossover</b> entre iguais (PC↔PC, Switch↔Switch, PC↔Router). Em "Automático" o cabo certo é escolhido sozinho.</li>
          <li>Serial só liga em serial; o lado <b>DCE</b> precisa de <code>clock rate</code> para o enlace subir.</li>
        </ul>
        <h3>2. Configurar</h3>
        <ul>
          <li><b>Duplo clique</b> abre a janela do equipamento.</li>
          <li>PC/notebook/servidor: aba <b>Config</b> ou <b>Desktop</b> (IP, máscara, gateway, DNS ou DHCP).</li>
          <li>Roteador/switch: aba <b>Config</b> (formulários) ou aba <b>CLI</b> (IOS de verdade).</li>
        </ul>
        <h3>3. Comandos IOS suportados</h3>
        <ul>
          <li><code>enable</code>, <code>configure terminal</code>, <code>hostname X</code>, <code>exit</code>, <code>end</code></li>
          <li><code>interface g0/0</code>, <code>ip address 192.168.1.1 255.255.255.0</code>, <code>no shutdown</code>, <code>description</code>, <code>clock rate 64000</code></li>
          <li><code>switchport mode access|trunk</code>, <code>switchport access vlan 10</code>, <code>vlan 10</code> + <code>name VENDAS</code></li>
          <li><code>ip route 192.168.3.0 255.255.255.0 10.0.0.2</code>, <code>ip default-gateway</code></li>
          <li><code>show ip interface brief</code>, <code>show ip route</code>, <code>show running-config</code>,
              <code>show mac address-table</code>, <code>show vlan brief</code>, <code>show interfaces</code>, <code>show ip arp</code></li>
          <li><code>ping</code>, <code>traceroute</code>, <code>copy running-config startup-config</code></li>
        </ul>
        <h3>4. Testar</h3>
        <ul>
          <li>Ferramenta <b>📨 Pacote</b> (tecla <b>P</b>): clique na <b>origem</b> e depois no <b>destino</b> para disparar
              um pacote de teste (ICMP echo). O resultado — sucesso, falha e o motivo — aparece na <b>Lista de PDUs</b>,
              no canto inferior direito. É o equivalente ao "Add Simple PDU" do Packet Tracer.</li>
          <li><b>🔬 Simulação</b>: troca do tempo real para o passo a passo. A rede congela e só anda quando você
              clica em <b>⏭ Próximo</b> (tecla <b>N</b>) — um salto de cabo por vez — ou em <b>▶ Auto</b>.
              Cada salto entra na <b>lista de eventos</b> (tempo, de quem, para quem, protocolo), e
              <b>clicar no evento abre o PDU</b>: Ethernet (MACs), IPv4 (endereços e TTL) e ICMP/ARP/DHCP/DNS,
              camada por camada. Os checkboxes filtram o protocolo que você quer acompanhar — desmarque ARP
              para seguir só o ping, por exemplo.</li>
          <li>No Desktop do PC: <code>ping 192.168.2.10</code>, <code>tracert</code>, <code>arp -a</code>, <code>ipconfig /all</code>, <code>ipconfig /renew</code>.</li>
          <li>Os quadros aparecem <b>animados nos cabos</b>, em forma de envelope com o nome do protocolo:
              amarelo = ARP, verde = ICMP, rosa = DHCP, azul = DNS, vermelho = erro ICMP. O cabo por onde o
              quadro está passando fica aceso.</li>
          <li>Cada cabo leva ~380 ms de simulação para o quadro atravessar. Use o controle de
              <b>Velocidade</b>: 0,25x para acompanhar quadro a quadro, 4x para terminar rápido.</li>
          <li>O rodapé mostra o que cada equipamento faz (aprendizado de MAC, flooding, decisão de rota, ARP...).</li>
          <li>Os tempos em ms são do <b>relógio da simulação</b>, por isso são maiores que numa rede real.</li>
        </ul>
        <h3>5. Levar para o laboratório real</h3>
        <ul>
          <li>Botão <b>🎓 Laboratório</b>: roteiros guiados (IP fixo, sub-rede, roteador, DHCP, VLAN, diagnóstico)
              com <b>verificação automática</b> e a seção "como fazer isso na bancada".</li>
          <li>Dentro da janela de cada equipamento, botão <b>🔧 Comandos reais</b>: gera o
              <code>netsh</code>/GUI do Windows, o <code>nmcli</code> do Linux ou o script IOS para colar no console,
              já com os valores que você configurou aqui.</li>
          <li>Na lista do Laboratório, <b>⚠ Armadilhas da bancada</b> reúne os motivos clássicos de
              "no simulador funcionou e no laboratório não" (firewall bloqueando ping, prompt sem administrador,
              Wi-Fi ligado junto com o cabo, APIPA 169.254.x.x...).</li>
        </ul>
        <h3>6. Endereçamento: o simulador cobra como o equipamento real</h3>
        <ul>
          <li>Endereço de <b>rede</b> ou de <b>broadcast</b> da sub-rede é recusado como IP de host — a mensagem
              manda refazer o cálculo e <b>não mostra a conta</b>.</li>
          <li><b>Conflito de IP</b>: ao aplicar um endereço, o equipamento envia ARP gratuito. Se outro já usa
              aquele IP, quem chegou depois perde o endereço (fica com ⚠ no ícone, <code>ipconfig</code> mostra
              "Duplicado" e o <code>ping</code> falha com "transmit failed").</li>
          <li>Máscara qualquer é aceita (/25, /26, /27, /30...), com rota conectada e longest prefix match reais —
              dá para praticar sub-rede e VLSM.</li>
        </ul>
        <h3>Atalhos</h3>
        <ul><li><kbd>V</kbd> selecionar · <kbd>C</kbd> cabo · <kbd>D</kbd> excluir · <kbd>Del</kbd> apagar seleção ·
        <kbd>Esc</kbd> cancelar · roda = zoom · <kbd>Shift</kbd>+arrastar = mover a tela</li></ul>
      </div>`;
    root.querySelector('.x').onclick = () => root.remove();
    dragWindow(root, root.querySelector('.winHead'));
    doc.getElementById('modalRoot').appendChild(root);
  }

  /* ============================================================== topologia demo */
  function demoTopology() {
    S.devices = {}; S.links = {}; S.counters = {};
    PT.engine.reset(); closeAllWindows();

    const r1 = M.createDevice('router', 620, 180);
    const sw1 = M.createDevice('switch', 380, 330);
    const sw2 = M.createDevice('switch', 860, 330);
    const pc0 = M.createDevice('pc', 250, 480);
    const pc1 = M.createDevice('pc', 430, 500);
    const pc2 = M.createDevice('pc', 760, 500);
    const srv = M.createDevice('server', 960, 480);

    const conf = (dev, ip, mask, gw) => {
      dev.ports[0].ip = ip; dev.ports[0].mask = mask; dev.gateway = gw; dev.dns = '192.168.2.100';
    };
    conf(pc0, '192.168.1.10', '255.255.255.0', '192.168.1.1');
    conf(pc1, '192.168.1.11', '255.255.255.0', '192.168.1.1');
    conf(pc2, '192.168.2.10', '255.255.255.0', '192.168.2.1');
    conf(srv, '192.168.2.100', '255.255.255.0', '192.168.2.1');
    srv.services.dns.on = true;
    srv.services.dns.records['servidor.local'] = '192.168.2.100';
    srv.services.dhcp = { on: true, start: '192.168.2.50', mask: '255.255.255.0', gw: '192.168.2.1', dns: '192.168.2.100', count: 20, leases: {} };

    const g0 = M.getPort(r1, 'GigabitEthernet0/0');
    const g1 = M.getPort(r1, 'GigabitEthernet0/1');
    g0.ip = '192.168.1.1'; g0.mask = '255.255.255.0'; g0.shutdown = false;
    g1.ip = '192.168.2.1'; g1.mask = '255.255.255.0'; g1.shutdown = false;

    const link = (a, pa, b, pb) => M.createLink(a, M.getPort(a, pa), b, M.getPort(b, pb), 'auto');
    link(r1, 'GigabitEthernet0/0', sw1, 'GigabitEthernet0/1');
    link(r1, 'GigabitEthernet0/1', sw2, 'GigabitEthernet0/1');
    link(pc0, 'FastEthernet0', sw1, 'FastEthernet0/1');
    link(pc1, 'FastEthernet0', sw1, 'FastEthernet0/2');
    link(pc2, 'FastEthernet0', sw2, 'FastEthernet0/1');
    link(srv, 'FastEthernet0', sw2, 'FastEthernet0/2');

    PT.engine.topologyChanged();
    render(); fitView(); setHint(); autosave();
    PT.engine.log(r1, 'info', 'topologia de exemplo carregada — teste: no PC0 execute "ping 192.168.2.10"');
    toast('Topologia de exemplo pronta — duplo clique no PC0 → Desktop → ping 192.168.2.10');
  }

  /* ==================================================================== init */
  function init() {
    initCanvas();
    initPalette();
    initLog();

    doc.querySelectorAll('.tool').forEach(b => b.onclick = () => setTool(b.dataset.tool));
    $('#cableType').onchange = e => { UI.cable = e.target.value; setHint(); };
    $('#btnPlay').onclick = e => {
      PT.engine.running = !PT.engine.running;
      e.target.textContent = PT.engine.running ? '⏸ Pausar' : '▶ Continuar';
    };
    $('#speed').oninput = e => { PT.engine.speed = +e.target.value; $('#speedVal').textContent = e.target.value + 'x'; };
    $('#btnDemo').onclick = demoTopology;
    $('#btnSave').onclick = saveFile;
    $('#btnLoad').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
    $('#btnClear').onclick = clearAll;
    $('#btnHelp').onclick = openHelp;
    $('#btnLab').onclick = () => PT.lab.open();
    $('#btnMode').onclick = () => setSimMode(!simAtivo());
    $('#btnStep').onclick = passo;
    $('#btnAuto').onclick = alternarAuto;
    $('#simClear').onclick = () => { PT.engine.clearEvents(); renderEvents(); };
    doc.querySelectorAll('[data-simf]').forEach(c => {
      c.onchange = () => { UI.simFilters[c.dataset.simf] = c.checked; renderEvents(); };
    });
    PT.engine.onEvent = () => { if (simAtivo()) renderEvents(); };
    $('#pduClear').onclick = () => { UI.pdus = []; renderPduList(); };
    $('#pduClose').onclick = () => { doc.getElementById('pduBox').hidden = true; };
    $('#zoomIn').onclick = () => zoomBy(0.85);
    $('#zoomOut').onclick = () => zoomBy(1.18);
    $('#zoomFit').onclick = fitView;

    window.addEventListener('resize', applyView);
    doc.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'v' || e.key === 'V') setTool('select');
      else if (e.key === 'c' || e.key === 'C') setTool('cable');
      else if (e.key === 'd' || e.key === 'D') setTool('delete');
      else if (e.key === 'p' || e.key === 'P') setTool('pdu');
      else if (e.key === 'n' || e.key === 'N') passo();
      else if (e.key === 'Escape') { UI.cableStart = null; UI.armedType = null; UI.pduFrom = null; drawRubber(null); render(); doc.querySelectorAll('.palItem').forEach(i => i.classList.remove('armed')); closePortMenu(); setHint(); }
      else if (e.key === 'Delete' && UI.selected) {
        if (UI.selected.kind === 'dev') M.removeDevice(UI.selected.id); else M.removeLink(UI.selected.id);
        UI.selected = null; PT.engine.topologyChanged(); render(); setHint(); autosave();
      }
    });

    // início sempre com a área de trabalho vazia; a topologia de exemplo só
    // entra pelo botão "Topologia exemplo"
    restore();
    render(); fitView(); setHint();
  }

  PT.ui = {
    init, render, renderPackets,
    refresh: () => { render(); updateSelection(); setHint(); refreshWindows(); autosave(); if (PT.lab) PT.lab.onRefresh(); },
    toast, openDeviceWindow, fitView, autosave, UI,
    makeWindow, elDiv, elBtn, closeWindows: closeAllWindows
  };
})(window);
