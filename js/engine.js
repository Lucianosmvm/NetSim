/* ==========================================================================
   engine.js — motor da simulação: quadros, ARP, ICMP, comutação, roteamento,
   DHCP e DNS. Tudo com animação em tempo real sobre os cabos.
   ========================================================================== */
(function (global) {
  'use strict';
  const PT = global.PT;
  const U = PT.util;
  const M = PT.model;
  const S = M.store;

  const WIRE_MS = 180;        // tempo de trânsito por cabo (ms de simulação)
  const ARP_TIMEOUT = 3000;
  const PING_TIMEOUT = 4000;

  const E = {
    clock: 0,
    running: true,
    speed: 1,
    inflight: [],
    timers: [],
    logs: [],
    onLog: null,        // callback da UI
    maxLogs: 400
  };

  /* ------------------------------------------------------------------ tempo */
  function after(ms, fn) {
    const t = { at: E.clock + ms, fn, dead: false };
    E.timers.push(t);
    return t;
  }

  function tick(dtReal) {
    if (!E.running) return;
    const dt = dtReal * E.speed;
    E.clock += dt;

    // pacotes em trânsito (antes dos temporizadores: um quadro que chega no
    // mesmo instante do timeout deve cancelá-lo)
    if (E.inflight.length) {
      const arrived = [];
      for (let i = E.inflight.length - 1; i >= 0; i--) {
        const p = E.inflight[i];
        p.t += dt;
        if (p.t >= p.dur) { arrived.push(p); E.inflight.splice(i, 1); }
      }
      arrived.forEach(p => {
        const dev = S.dev(p.toDev);
        if (!dev) return;
        const port = M.getPort(dev, p.toPort);
        if (!port || !M.isPortUp(dev, port)) return;
        port.rx++;
        inputFrame(dev, port, p.frame);
      });
    }

    // temporizadores (ARP/ping/DHCP)
    if (E.timers.length) {
      const due = E.timers.filter(t => !t.dead && t.at <= E.clock);
      if (due.length) {
        E.timers = E.timers.filter(t => !t.dead && t.at > E.clock);
        due.forEach(t => { try { t.fn(); } catch (e) { console.error(e); } });
      }
    }
  }

  /* ------------------------------------------------------------------ log */
  function log(dev, kind, text) {
    const row = { t: Math.round(E.clock), dev: dev ? dev.name : '—', kind, text };
    E.logs.push(row);
    if (E.logs.length > E.maxLogs) E.logs.shift();
    if (E.onLog) E.onLog(row);
  }

  /* ------------------------------------------------------------------ quadros */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function ethFrame(src, dst, type, body, vlan) {
    const f = { id: U.uid('f'), src, dst, type, vlan: vlan || null };
    if (type === 'arp') f.arp = body; else f.ip = body;
    return f;
  }

  function pktColor(frame) {
    if (frame.type === 'arp') return '#eab308';
    if (frame.ip && frame.ip.proto === 'udp') {
      const app = frame.ip.udp && frame.ip.udp.app;
      return app === 'dhcp' ? '#f472b6' : '#38bdf8';
    }
    if (frame.ip && frame.ip.proto === 'icmp') {
      const t = frame.ip.icmp.type;
      return (t === 'echo-request' || t === 'echo-reply') ? '#4ade80' : '#f87171';
    }
    return '#94a3b8';
  }

  function pktLabel(frame) {
    if (frame.type === 'arp') return 'ARP';
    if (frame.ip.proto === 'icmp') {
      const t = frame.ip.icmp.type;
      return t === 'echo-request' ? 'ICMP' : t === 'echo-reply' ? 'ICMP' : 'ERR';
    }
    if (frame.ip.proto === 'udp') return (frame.ip.udp.app || 'UDP').toUpperCase();
    return 'IP';
  }

  /** Coloca o quadro no cabo ligado a `port`. */
  function sendFrame(dev, port, frame) {
    if (!M.isPortUp(dev, port)) {
      log(dev, 'err', `descartado: ${port.name} está down`);
      return false;
    }
    const nb = M.neighbor(dev, port);
    if (!nb || !nb.port) return false;
    port.tx++;
    E.inflight.push({
      id: U.uid('p'),
      linkId: nb.link.id,
      fromDev: dev.id, fromPort: port.name,
      toDev: nb.dev.id, toPort: nb.port.name,
      t: 0, dur: WIRE_MS,
      frame: clone(frame),
      color: pktColor(frame),
      label: pktLabel(frame)
    });
    return true;
  }

  /* ------------------------------------------------------------------ entrada */
  function inputFrame(dev, port, frame) {
    switch (dev.type) {
      case 'hub': return hubIn(dev, port, frame);
      case 'switch': return switchIn(dev, port, frame);
      case 'router': return routerIn(dev, port, frame);
      default: return hostIn(dev, port, frame);
    }
  }

  /* --------------------------------------------------------------- HUB (L1) */
  function hubIn(dev, port, frame) {
    log(dev, 'switch', `repetiu quadro de ${port.name} para todas as portas`);
    M.physicalPorts(dev).forEach(p => {
      if (p.name !== port.name && M.isPortUp(dev, p)) sendFrame(dev, p, frame);
    });
  }

  /* ------------------------------------------------------------ SWITCH (L2) */
  function switchIn(dev, port, frame) {
    const vlan = port.mode === 'trunk' ? (frame.vlan || port.nativeVlan || 1) : port.vlan;

    // aprendizado de MAC
    const known = dev.macTable[frame.src];
    if (!known || known.port !== port.name) {
      dev.macTable[frame.src] = { port: port.name, vlan, ts: E.clock, dynamic: true };
      log(dev, 'switch', `aprendeu ${frame.src} na ${port.name} (VLAN ${vlan})`);
    } else known.ts = E.clock;

    // interface de gerência (SVI)
    const svi = dev.ports.find(p => p.kind === 'vlan' && p.vlan === vlan);
    if (svi && ipUsable(svi) && M.isPortUp(dev, svi) &&
      (frame.dst === svi.mac || U.isBcastMac(frame.dst))) {
      hostProcess(dev, svi, frame);
      if (!U.isBcastMac(frame.dst)) return;
    }

    if (!U.isBcastMac(frame.dst)) {
      const e = dev.macTable[frame.dst];
      if (e && e.vlan === vlan && e.port !== port.name) {
        const out = M.getPort(dev, e.port);
        if (out && M.isPortUp(dev, out)) { egress(dev, out, vlan, frame); return; }
      }
      if (e && e.port === port.name) return;   // mesma porta: descarta
    }

    // flooding (broadcast ou destino desconhecido) dentro da VLAN
    log(dev, 'switch', U.isBcastMac(frame.dst)
      ? `broadcast inundado na VLAN ${vlan}`
      : `MAC ${frame.dst} desconhecido — inundando VLAN ${vlan}`);
    M.physicalPorts(dev).forEach(p => {
      if (p.name === port.name || !M.isPortUp(dev, p)) return;
      if (p.mode === 'trunk' || p.vlan === vlan) egress(dev, p, vlan, frame);
    });
  }

  function egress(dev, port, vlan, frame) {
    const f = clone(frame);
    if (port.mode === 'trunk') f.vlan = vlan;
    else { if (port.vlan !== vlan) return; f.vlan = null; }
    sendFrame(dev, port, f);
  }

  /* ------------------------------------------------------------ HOST / SVI */
  function hostIn(dev, port, frame) {
    if (frame.dst !== port.mac && !U.isBcastMac(frame.dst)) return;   // não é para mim
    hostProcess(dev, port, frame);
  }

  function hostProcess(dev, port, frame) {
    if (frame.type === 'arp') return arpIn(dev, port, frame);
    if (frame.type !== 'ip') return;
    const ip = frame.ip;
    const mine = ipUsable(port) && (ip.dst === port.ip || U.isBroadcastIp(ip.dst) ||
      (port.mask && ip.dst === U.broadcastOf(port.ip, port.mask)));
    const dhcpToMe = ip.proto === 'udp' && ip.udp.app === 'dhcp';
    if (!mine && !dhcpToMe) return;
    ipLocal(dev, port, frame);
  }

  /* ---------------------------------------------------------- ROTEADOR (L3) */
  function routerIn(dev, port, frame) {
    if (port.kind !== 'serial' && frame.dst !== port.mac && !U.isBcastMac(frame.dst)) return;
    if (frame.type === 'arp') return arpIn(dev, port, frame);
    if (frame.type !== 'ip') return;

    const ip = frame.ip;
    const forMe = dev.ports.some(p => ipUsable(p) && p.ip === ip.dst) ||
      U.isBroadcastIp(ip.dst) ||
      (port.ip && port.mask && ip.dst === U.broadcastOf(port.ip, port.mask));

    if (forMe) return ipLocal(dev, port, frame);
    forward(dev, port, frame);
  }

  function forward(dev, inPort, frame) {
    const ip = frame.ip;
    ip.ttl = (ip.ttl | 0) - 1;
    if (ip.ttl <= 0) {
      log(dev, 'err', `TTL expirou para ${ip.dst} — enviando ICMP Time Exceeded a ${ip.src}`);
      icmpError(dev, ip, 'time-exceeded');
      return;
    }
    const r = lookup(dev, ip.dst);
    if (!r || !r.iface) {
      log(dev, 'err', `sem rota para ${ip.dst} — ICMP Destination Unreachable`);
      icmpError(dev, ip, 'unreachable-net');
      return;
    }
    const out = M.getPort(dev, r.iface);
    if (!out || !M.isPortUp(dev, out)) {
      icmpError(dev, ip, 'unreachable-net');
      return;
    }
    if (out.name === inPort.name && r.type !== 'C') {
      log(dev, 'route', `rota aponta de volta pela ${out.name}`);
    }
    log(dev, 'route', `roteando ${ip.src} → ${ip.dst} pela ${out.name}` +
      (r.nh ? ` (próximo salto ${r.nh})` : ' (rede conectada)'));
    deliverOut(dev, out, r.nh || ip.dst, ip, () => icmpError(dev, ip, 'unreachable-host'));
  }

  /** Encapsula e envia um pacote IP por uma interface (resolve ARP se preciso). */
  function deliverOut(dev, port, nextHop, ipPkt, onFail) {
    if (port.kind === 'serial') {
      sendFrame(dev, port, ethFrame('HDLC', 'HDLC', 'ip', ipPkt));
      return;
    }
    if (U.isBroadcastIp(ipPkt.dst)) {
      sendFrame(dev, port, ethFrame(port.mac, U.BCAST_MAC, 'ip', ipPkt));
      return;
    }
    arpResolve(dev, port, nextHop, mac => {
      if (!mac) { if (onFail) onFail(); return; }
      sendFrame(dev, port, ethFrame(port.mac, mac, 'ip', ipPkt));
    });
  }

  /* ------------------------------------------------------------------ ARP */
  function mkArp(op, senderMac, senderIp, targetMac, targetIp) {
    return ethFrame(senderMac, op === 'request' ? U.BCAST_MAC : targetMac, 'arp',
      { op, senderMac, senderIp, targetMac: op === 'request' ? '0000.0000.0000' : targetMac, targetIp });
  }

  function arpIn(dev, port, frame) {
    const a = frame.arp;
    if (a.op === 'request') {
      // alguém anunciando um IP igual ao meu = conflito (ARP gratuito alheio)
      if (ipUsable(port) && a.senderIp === port.ip && a.senderMac !== port.mac) {
        log(dev, 'err', `outro equipamento (${a.senderMac}) anunciou ${port.ip}, que já é meu — endereço duplicado na rede`);
      }
      if (a.senderIp && a.senderIp !== '0.0.0.0') dev.arp[a.senderIp] = { mac: a.senderMac, port: port.name, ts: E.clock };
      if (ipUsable(port) && a.targetIp === port.ip) {
        log(dev, 'arp', `ARP request de ${a.senderIp} → respondendo ${port.ip} está em ${port.mac}`);
        sendFrame(dev, port, mkArp('reply', port.mac, port.ip, a.senderMac, a.senderIp));
      }
    } else if (a.op === 'reply') {
      if (a.targetMac !== port.mac) return;
      // resposta ao meu ARP gratuito: alguém já usa este endereço
      const probe = dev._probe && dev._probe[port.name];
      if (probe && a.senderIp === probe.ip && a.senderMac !== port.mac) {
        delete dev._probe[port.name];
        conflitoDeIp(dev, port, a.senderMac);
        return;
      }
      log(dev, 'arp', `ARP reply: ${a.senderIp} está em ${a.senderMac}`);
      dev.arp[a.senderIp] = { mac: a.senderMac, port: port.name, ts: E.clock };
      const cbs = dev.pendingArp[a.senderIp] || [];
      delete dev.pendingArp[a.senderIp];
      cbs.forEach(cb => cb(a.senderMac));
    }
  }

  /* ------------------------------------------- conflito de endereço IP */

  /** O endereço da porta pode ser usado? (falso enquanto houver conflito) */
  function ipUsable(port) { return !!(port && port.ip && !port.ipConflict); }

  /** ARP gratuito: "alguém já usa este endereço?" — igual ao que o Windows faz. */
  function announceIp(dev, port) {
    if (!port.ip || !M.isPortUp(dev, port)) return;
    port.ipConflict = false;
    dev._probe = dev._probe || {};
    dev._probe[port.name] = { ip: port.ip, ts: E.clock };
    log(dev, 'arp', `ARP gratuito em ${port.name}: verificando se ${port.ip} já está em uso`);
    sendFrame(dev, port, mkArp('request', port.mac, '0.0.0.0', null, port.ip));
    after(2500, () => {
      const pr = dev._probe && dev._probe[port.name];
      if (pr && pr.ip === port.ip) delete dev._probe[port.name];   // ninguém respondeu: endereço livre
    });
  }

  function conflitoDeIp(dev, port, outroMac) {
    const outro = S.list().find(d => d.ports.some(p => p.mac === outroMac));
    const outraPorta = outro && outro.ports.find(p => p.mac === outroMac);

    // empate: os dois anunciaram ao mesmo tempo (topologia carregada já duplicada).
    // Desempate determinístico — quem tem o MAC menor fica com o endereço.
    const outroTambemAnunciando = !!(outro && outro._probe && outro._probe[outraPorta.name] &&
      outro._probe[outraPorta.name].ip === port.ip);
    if (outroTambemAnunciando && port.mac < outroMac) {
      log(dev, 'err', `endereço ${port.ip} duplicado com ${outro.name} — mantido aqui, o outro equipamento deve trocar`);
      return;
    }

    port.ipConflict = true;
    log(dev, 'err',
      `CONFLITO DE ENDEREÇO IP: ${port.ip} já está em uso por ${outro ? outro.name : outroMac} — ` +
      `o endereço foi desativado em ${port.name}`);
    if (PT.ui) {
      PT.ui.toast(`Conflito de IP: ${port.ip} já está em uso${outro ? ' por ' + outro.name : ''}. ` +
        `O endereço de ${dev.name} foi desativado.`, true);
      PT.ui.refresh();
    }
  }

  /** Anuncia as portas cujo endereço/enlace mudou desde a última verificação. */
  function announceChanged() {
    S.list().forEach(d => d.ports.forEach(p => {
      const estado = (p.ip || '') + '|' + (M.isPortUp(d, p) ? 1 : 0);
      if (p._annState === estado) return;
      p._annState = estado;
      if (p.ip && M.isPortUp(d, p)) announceIp(d, p);
      else if (!p.ip) p.ipConflict = false;
    }));
  }

  let annTimer = null;
  function scheduleAnnounce() {
    if (annTimer) annTimer.dead = true;
    annTimer = after(300, () => { annTimer = null; announceChanged(); });
  }

  function arpResolve(dev, port, ip, cb) {
    const hit = dev.arp[ip];
    if (hit) return cb(hit.mac);
    const q = dev.pendingArp[ip] = dev.pendingArp[ip] || [];
    q.push(cb);
    if (q.length > 1) return;                 // já existe request em andamento

    log(dev, 'arp', `quem tem ${ip}? enviando ARP request por ${port.name}`);
    sendFrame(dev, port, mkArp('request', port.mac, port.ip || '0.0.0.0', null, ip));
    after(ARP_TIMEOUT, () => {
      if (dev.arp[ip]) return;
      const list = dev.pendingArp[ip] || [];
      delete dev.pendingArp[ip];
      if (list.length) log(dev, 'err', `ARP para ${ip} sem resposta`);
      list.forEach(f => f(null));
    });
  }

  /* -------------------------------------------------------------- rotas IP */
  function routes(dev) {
    const rs = [];
    dev.ports.forEach(p => {
      if (ipUsable(p) && p.mask && M.isPortUp(dev, p)) {
        rs.push({ net: U.networkOf(p.ip, p.mask), mask: p.mask, iface: p.name, nh: null, type: 'C', metric: 0 });
      }
    });
    const findIface = nh => {
      const c = rs.find(x => x.type === 'C' && U.sameSubnet(x.net, nh, x.mask));
      return c ? c.iface : null;
    };
    if (dev.type === 'router') {
      (dev.staticRoutes || []).forEach(r => {
        const iface = r.iface || (r.nh ? findIface(r.nh) : null);
        rs.push({
          net: r.net, mask: r.mask, iface, nh: r.nh || null,
          type: (r.net === '0.0.0.0' && r.mask === '0.0.0.0') ? 'S*' : 'S', metric: 1
        });
      });
    } else if (dev.gateway) {
      rs.push({ net: '0.0.0.0', mask: '0.0.0.0', iface: findIface(dev.gateway), nh: dev.gateway, type: 'S*', metric: 1 });
    }
    return rs;
  }

  /** Longest prefix match. */
  function lookup(dev, dst) {
    let best = null, bestLen = -1;
    routes(dev).forEach(r => {
      if (!r.iface) return;
      const len = U.maskToPrefix(r.mask);
      if (U.networkOf(dst, r.mask) === U.networkOf(r.net, r.mask) && len > bestLen) { best = r; bestLen = len; }
    });
    return best;
  }

  function defaultTtl(dev) { return dev.type === 'router' || dev.type === 'switch' ? 255 : 128; }

  /**
   * Origina um pacote IP a partir de `dev`.
   * onFail(reason): 'no-route' | 'arp' | 'iface-down'
   */
  function ipSend(dev, pkt, onFail) {
    if (U.isBroadcastIp(pkt.dst)) {
      const p = dev.ports.find(x => x.kind !== 'vlan' && M.isPortUp(dev, x));
      if (!p) { if (onFail) onFail('iface-down'); return; }
      if (!pkt.src) pkt.src = p.ip || '0.0.0.0';
      sendFrame(dev, p, ethFrame(p.mac, U.BCAST_MAC, 'ip', pkt));
      return;
    }
    const r = lookup(dev, pkt.dst);
    if (!r || !r.iface) { if (onFail) onFail('no-route'); return; }
    const port = M.getPort(dev, r.iface);
    if (!port || !M.isPortUp(dev, port)) { if (onFail) onFail('iface-down'); return; }
    if (!pkt.src) pkt.src = port.ip;
    deliverOut(dev, port, r.nh || pkt.dst, pkt, () => { if (onFail) onFail('arp'); });
  }

  function icmpError(dev, origIp, kind) {
    ipSend(dev, {
      src: '', dst: origIp.src, ttl: defaultTtl(dev), proto: 'icmp',
      icmp: {
        type: kind,
        orig: {
          src: origIp.src, dst: origIp.dst,
          id: origIp.icmp ? origIp.icmp.id : null,
          seq: origIp.icmp ? origIp.icmp.seq : null
        }
      }
    });
  }

  /* --------------------------------------------------- processamento local */
  function ipLocal(dev, port, frame) {
    const ip = frame.ip;
    if (ip.proto === 'icmp') return icmpLocal(dev, port, ip);
    if (ip.proto === 'udp') return udpLocal(dev, port, ip);
  }

  function icmpLocal(dev, port, ip) {
    const ic = ip.icmp;
    if (ic.type === 'echo-request') {
      log(dev, 'icmp', `echo request de ${ip.src} — respondendo`);
      ipSend(dev, {
        src: dev.ports.some(p => ipUsable(p) && p.ip === ip.dst) ? ip.dst : port.ip,
        dst: ip.src, ttl: defaultTtl(dev), proto: 'icmp',
        icmp: { type: 'echo-reply', id: ic.id, seq: ic.seq, size: ic.size }
      });
      return;
    }
    const key = ic.type === 'echo-reply'
      ? ic.id + ':' + ic.seq
      : (ic.orig ? ic.orig.id + ':' + ic.orig.seq : null);
    const w = key && dev.echoWait[key];
    if (!w) return;
    delete dev.echoWait[key];
    w.cb({
      ok: ic.type === 'echo-reply',
      type: ic.type,
      from: ip.src,
      ttl: ip.ttl,
      rtt: Math.max(0, Math.round(E.clock - w.t0)),
      size: ic.size || 32
    });
  }

  /* ------------------------------------------------------------- DHCP/DNS */
  function udpLocal(dev, port, ip) {
    const u = ip.udp;
    if (u.app === 'dhcp') return dhcpIn(dev, port, ip);
    if (u.app === 'dns') return dnsIn(dev, port, ip);
  }

  function dhcpIn(dev, port, ip) {
    const u = ip.udp;
    const svc = dev.services && dev.services.dhcp;

    // ---- lado servidor
    if (svc && svc.on && (u.op === 'discover' || u.op === 'request')) {
      const addr = dhcpAlloc(dev, u.mac);
      if (!addr) { log(dev, 'err', 'pool DHCP esgotado'); return; }
      const op = u.op === 'discover' ? 'offer' : 'ack';
      log(dev, 'dhcp', `${u.op.toUpperCase()} de ${u.mac} → ${op.toUpperCase()} ${addr}`);
      sendFrame(dev, port, ethFrame(port.mac, u.mac, 'ip', {
        src: port.ip, dst: '255.255.255.255', ttl: 64, proto: 'udp',
        udp: {
          sport: 67, dport: 68, app: 'dhcp', op, mac: u.mac, xid: u.xid,
          yiaddr: addr, mask: svc.mask, gw: svc.gw, dns: svc.dns, server: port.ip
        }
      }));
      return;
    }

    // ---- lado cliente
    if (u.op === 'offer' && dev._dhcp && dev._dhcp.xid === u.xid && u.mac === port.mac) {
      log(dev, 'dhcp', `OFFER ${u.yiaddr} de ${u.server} — enviando REQUEST`);
      sendFrame(dev, port, ethFrame(port.mac, U.BCAST_MAC, 'ip', {
        src: '0.0.0.0', dst: '255.255.255.255', ttl: 64, proto: 'udp',
        udp: { sport: 68, dport: 67, app: 'dhcp', op: 'request', mac: port.mac, xid: u.xid, requested: u.yiaddr }
      }));
      return;
    }
    if (u.op === 'ack' && dev._dhcp && dev._dhcp.xid === u.xid && u.mac === port.mac) {
      port.ip = u.yiaddr; port.mask = u.mask || '255.255.255.0';
      dev.gateway = u.gw || dev.gateway;
      dev.dns = u.dns || dev.dns;
      log(dev, 'dhcp', `ACK — endereço ${port.ip}/${U.maskToPrefix(port.mask)} atribuído`);
      const cb = dev._dhcp.cb; dev._dhcp = null;
      if (cb) cb({ ok: true, ip: port.ip, mask: port.mask, gw: dev.gateway, dns: dev.dns });
      if (PT.ui) PT.ui.refresh();
    }
  }

  function dhcpAlloc(dev, mac) {
    const svc = dev.services.dhcp;
    if (svc.leases[mac]) return svc.leases[mac];
    if (!U.isValidIp(svc.start)) return null;
    const start = U.ipToInt(svc.start);
    const taken = new Set(Object.values(svc.leases));
    for (let i = 0; i < (svc.count || 50); i++) {
      const cand = U.intToIp(start + i);
      if (taken.has(cand)) continue;
      if (S.list().some(d => d.ports.some(p => p.ip === cand))) continue;
      svc.leases[mac] = cand;
      return cand;
    }
    return null;
  }

  function dhcpStart(dev, cb) {
    const port = dev.ports.find(p => p.kind !== 'vlan');
    if (!port || !M.isPortUp(dev, port)) { if (cb) cb({ ok: false, err: 'link' }); return; }
    const xid = Math.floor(Math.random() * 0xFFFF);
    dev._dhcp = { xid, cb };
    port.ip = ''; port.mask = '';
    log(dev, 'dhcp', 'enviando DHCP DISCOVER (broadcast)');
    sendFrame(dev, port, ethFrame(port.mac, U.BCAST_MAC, 'ip', {
      src: '0.0.0.0', dst: '255.255.255.255', ttl: 64, proto: 'udp',
      udp: { sport: 68, dport: 67, app: 'dhcp', op: 'discover', mac: port.mac, xid }
    }));
    after(4000, () => {
      if (dev._dhcp && dev._dhcp.xid === xid) {
        dev._dhcp = null;
        log(dev, 'err', 'DHCP sem resposta');
        if (cb) cb({ ok: false, err: 'timeout' });
      }
    });
  }

  function dnsIn(dev, port, ip) {
    const u = ip.udp;
    const svc = dev.services && dev.services.dns;
    if (u.op === 'query' && svc && svc.on) {
      const rec = svc.records[String(u.name).toLowerCase()];
      log(dev, 'dns', `consulta ${u.name} → ${rec || 'NXDOMAIN'}`);
      ipSend(dev, {
        src: port.ip, dst: ip.src, ttl: 64, proto: 'udp',
        udp: { sport: 53, dport: u.sport, app: 'dns', op: 'reply', name: u.name, ip: rec || null, xid: u.xid }
      });
      return;
    }
    if (u.op === 'reply' && dev._dns && dev._dns.xid === u.xid) {
      const cb = dev._dns.cb; dev._dns = null;
      if (cb) cb(u.ip || null);
    }
  }

  /** Resolve nome → IP (usa servidor DNS configurado no host). */
  function resolve(dev, target, cb) {
    if (U.isValidIp(target)) return cb(target);
    const byName = S.byName(target);
    if (byName) {                       // atalho: nome do dispositivo na topologia
      const p = byName.ports.find(x => x.ip);
      if (p && !dev.dns) return cb(p.ip);
    }
    if (!dev.dns || !U.isValidIp(dev.dns)) return cb(null);
    const xid = Math.floor(Math.random() * 0xFFFF);
    dev._dns = { xid, cb };
    ipSend(dev, {
      src: '', dst: dev.dns, ttl: 64, proto: 'udp',
      udp: { sport: 1024 + Math.floor(Math.random() * 1000), dport: 53, app: 'dns', op: 'query', name: target, xid }
    }, () => { dev._dns = null; cb(null); });
    after(3000, () => { if (dev._dns && dev._dns.xid === xid) { dev._dns = null; cb(null); } });
  }

  /* ------------------------------------------------------------------ ping */
  function pingOnce(dev, dstIp, opts, cb) {
    opts = opts || {};
    const id = ((dev._pid = (dev._pid || 0) + 1) & 0xFFFF);
    const seq = id;
    const key = id + ':' + seq;
    let done = false;
    const finish = res => { if (done) return; done = true; delete dev.echoWait[key]; cb(res); };

    dev.echoWait[key] = { t0: E.clock, cb: finish };
    ipSend(dev, {
      src: opts.src || '', dst: dstIp, ttl: opts.ttl || defaultTtl(dev), proto: 'icmp',
      icmp: { type: 'echo-request', id, seq, size: opts.size || 32 }
    }, reason => finish({ ok: false, err: reason }));

    after(opts.timeout || PING_TIMEOUT, () => finish({ ok: false, err: 'timeout' }));
  }

  /**
   * ping completo estilo Packet Tracer.
   * cbs: {onLine(text), onDone(stats)}
   */
  function ping(dev, target, opts, cbs) {
    opts = opts || {};
    const count = opts.count || 4;
    const write = cbs.onLine || function () { };
    resolve(dev, target, ip => {
      if (!ip) {
        write(`Ping request could not find host ${target}. Please check the name and try again.`);
        if (cbs.onDone) cbs.onDone(null);
        return;
      }
      write(opts.ios
        ? `Type escape sequence to abort.\nSending ${count}, ${opts.size || 100}-byte ICMP Echos to ${ip}, timeout is 2 seconds:`
        : `\nPinging ${ip} with ${opts.size || 32} bytes of data:\n`);
      const stats = { sent: 0, recv: 0, times: [], target: ip, marks: '' };
      let i = 0;
      const step = () => {
        if (i >= count) {
          if (opts.ios) write(stats.marks);
          summary(stats, write, opts);
          if (cbs.onDone) cbs.onDone(stats);
          return;
        }
        i++; stats.sent++;
        pingOnce(dev, ip, { ttl: opts.ttl, size: opts.size, src: opts.src }, res => {
          if (res.ok) {
            stats.recv++; stats.times.push(res.rtt); stats.marks += '!';
            if (!opts.ios) write(`Reply from ${res.from}: bytes=${res.size} time=${res.rtt}ms TTL=${res.ttl}`);
          } else if (res.type === 'unreachable-net' || res.type === 'unreachable-host') {
            stats.marks += 'U';
            if (!opts.ios) write(`Reply from ${res.from}: Destination host unreachable.`);
          } else if (res.err === 'no-route' || res.err === 'iface-down') {
            stats.marks += 'U';
            if (!opts.ios) write('PING: transmit failed. General failure.');
          } else if (res.err === 'arp') {
            stats.marks += '.';
            if (!opts.ios) write('Request timed out.');
          } else {
            stats.marks += '.';
            if (!opts.ios) write('Request timed out.');
          }
          after(opts.interval === undefined ? 500 : opts.interval, step);
        });
      };
      step();
    });
  }

  function summary(st, write, opts) {
    if (opts.ios) {
      const pct = Math.round(100 * st.recv / Math.max(1, st.sent));
      let line = `Success rate is ${pct} percent (${st.recv}/${st.sent})`;
      if (st.times.length) {
        line += `, round-trip min/avg/max = ${Math.min(...st.times)}/${Math.round(st.times.reduce((a, b) => a + b, 0) / st.times.length)}/${Math.max(...st.times)} ms`;
      }
      write(line);
      return;
    }
    const lost = st.sent - st.recv;
    write(`\nPing statistics for ${st.target}:`);
    write(`    Packets: Sent = ${st.sent}, Received = ${st.recv}, Lost = ${lost} (${Math.round(100 * lost / Math.max(1, st.sent))}% loss),`);
    if (st.times.length) {
      write('Approximate round trip times in milli-seconds:');
      write(`    Minimum = ${Math.min(...st.times)}ms, Maximum = ${Math.max(...st.times)}ms, Average = ${Math.round(st.times.reduce((a, b) => a + b, 0) / st.times.length)}ms`);
    }
  }

  /* --------------------------------------------------------------- tracert */
  function trace(dev, target, opts, cbs) {
    opts = opts || {};
    const write = cbs.onLine || function () { };
    const maxHops = opts.maxHops || 30;
    resolve(dev, target, ip => {
      if (!ip) {
        write(`Unable to resolve target system name ${target}.`);
        if (cbs.onDone) cbs.onDone();
        return;
      }
      write(`\nTracing route to ${ip} over a maximum of ${maxHops} hops:\n`);
      let ttl = 1;
      const hop = () => {
        if (ttl > maxHops) { write('\nTrace complete.'); if (cbs.onDone) cbs.onDone(); return; }
        const probes = [];
        let n = 0;
        const probe = () => {
          if (n >= 3) {
            const addr = probes.find(p => p.from) ;
            const times = probes.map(p => p.from ? `${U.padL(p.rtt, 3)} ms` : '     *').join('  ');
            write(`  ${U.padL(ttl, 2)}   ${times}   ${addr ? addr.from : 'Request timed out.'}`);
            const reached = probes.some(p => p.done);
            if (reached) { write('\nTrace complete.'); if (cbs.onDone) cbs.onDone(); return; }
            ttl++; after(200, hop); return;
          }
          n++;
          pingOnce(dev, ip, { ttl, timeout: 2000 }, res => {
            probes.push({
              from: res.ok || res.type === 'time-exceeded' || String(res.type || '').indexOf('unreachable') === 0 ? res.from : null,
              rtt: res.rtt || 0,
              done: res.ok
            });
            after(120, probe);
          });
        };
        probe();
      };
      hop();
    });
  }

  /* ---------------------------------------------------- mudanças na topologia */
  /** Limpa caches quando a topologia/config muda (evita rota fantasma). */
  function topologyChanged() {
    S.list().forEach(d => {
      d.arp = {}; d.pendingArp = {};
      if (d.type === 'switch') d.macTable = {};
    });
    scheduleAnnounce();
  }

  function reset() {
    E.inflight.length = 0; E.timers.length = 0; E.clock = 0; E.logs.length = 0;
    S.list().forEach(d => {
      d.echoWait = {}; d._dhcp = null; d._dns = null; d._probe = {};
      d.ports.forEach(p => { p.ipConflict = false; p._annState = undefined; });
    });
    topologyChanged();
  }

  PT.engine = Object.assign(E, {
    tick, after, log, sendFrame, ipSend, routes, lookup, ping, pingOnce, trace,
    resolve, dhcpStart, topologyChanged, reset, defaultTtl, WIRE_MS,
    announceIp, announceChanged, ipUsable
  });
})(window);
