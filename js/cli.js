/* ==========================================================================
   cli.js — dois interpretadores de linha de comando:
     • HostShell : prompt do Windows (ipconfig, ping, tracert, arp, nslookup)
     • IosShell  : Cisco IOS (enable, configure terminal, interface, show ...)
   ========================================================================== */
(function (global) {
  'use strict';
  const PT = global.PT;
  const U = PT.util;
  const M = PT.model;
  const S = M.store;

  const INVALID = "% Invalid input detected at '^' marker.";
  const INCOMPLETE = '% Incomplete command.';

  /* ---------------------------------------------------------------- helpers */
  function shortIf(name) {
    return name
      .replace(/^GigabitEthernet/i, 'Gig')
      .replace(/^FastEthernet/i, 'Fa')
      .replace(/^Ethernet/i, 'Et')
      .replace(/^Serial/i, 'Se')
      .replace(/^Vlan/i, 'Vl');
  }

  /** "g0/0", "gi0/0", "fa0/1", "s0/0/0", "vlan 1" → nome completo da porta */
  function normIf(dev, tokens) {
    if (!tokens.length) return null;
    let raw = tokens.join('');
    const m = raw.match(/^([a-zA-Z\-]+)([\d\/\.]*)$/);
    if (!m) return null;
    const word = m[1].toLowerCase(), num = m[2];
    const map = [
      ['gigabitethernet', 'GigabitEthernet'], ['fastethernet', 'FastEthernet'],
      ['ethernet', 'Ethernet'], ['serial', 'Serial'], ['vlan', 'Vlan']
    ];
    let full = null;
    for (const [k, v] of map) { if (k.indexOf(word) === 0) { full = v; break; } }
    if (!full) {
      if (word[0] === 'g') full = 'GigabitEthernet';
      else if (word[0] === 'f') full = 'FastEthernet';
      else if (word[0] === 'e') full = 'Ethernet';
      else if (word[0] === 's') full = 'Serial';
      else if (word[0] === 'v') full = 'Vlan';
    }
    if (!full) return null;
    const cand = full + num;
    return M.getPort(dev, cand) ? cand : null;
  }

  function ifStatus(dev, p) {
    if (p.shutdown) return ['administratively down', 'down'];
    const up = M.isPortUp(dev, p);
    if (p.kind === 'vlan') return [up ? 'up' : 'down', up ? 'up' : 'down'];
    const l = M.linkOf(p);
    if (!l) return ['down', 'down'];
    return [up ? 'up' : 'up', up ? 'up' : 'down'];
  }

  /* ======================================================================
     HostShell — prompt do Windows (PC / notebook / servidor)
     ====================================================================== */
  function HostShell(dev) { this.dev = dev; }

  HostShell.prototype.prompt = function () { return 'C:\\>'; };

  HostShell.prototype.exec = function (line, ctx) {
    const dev = this.dev;
    const args = line.trim().split(/\s+/).filter(Boolean);
    if (!args.length) return ctx.done();
    const cmd = args[0].toLowerCase();
    const W = ctx.write;

    switch (cmd) {
      case '?':
      case 'help':
        W([
          'Comandos disponíveis:',
          '  ipconfig [/all] [/renew] [/release]',
          '  ping <ip|nome> [-n contagem] [-l tamanho]',
          '  tracert <ip|nome>',
          '  arp -a | arp -d',
          '  nslookup <nome>',
          '  hostname',
          '  cls'
        ].join('\n'));
        return ctx.done();

      case 'cls': ctx.clear(); return ctx.done();
      case 'hostname': W(dev.name); return ctx.done();

      case 'ipconfig': return this.ipconfig(args.slice(1), ctx);

      case 'ping': {
        const t = args[1];
        if (!t) { W('Usage: ping <destino>'); return ctx.done(); }
        let count = 4, size = 32;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '-n' && args[i + 1]) count = U.clamp(parseInt(args[++i], 10) || 4, 1, 20);
          if (args[i] === '-l' && args[i + 1]) size = U.clamp(parseInt(args[++i], 10) || 32, 32, 1500);
        }
        PT.engine.ping(dev, t, { count, size }, { onLine: W, onDone: () => ctx.done() });
        return;
      }

      case 'tracert':
      case 'traceroute': {
        const t = args[1];
        if (!t) { W('Usage: tracert <destino>'); return ctx.done(); }
        PT.engine.trace(dev, t, {}, { onLine: W, onDone: () => ctx.done() });
        return;
      }

      case 'arp': {
        const opt = (args[1] || '-a').toLowerCase();
        if (opt === '-d') { dev.arp = {}; W('Cache ARP limpo.'); return ctx.done(); }
        const port = dev.ports.find(p => p.ip) || dev.ports[0];
        W(`Interface: ${port.ip || '0.0.0.0'} --- 0x1`);
        W('  Internet Address      Physical Address      Type');
        Object.keys(dev.arp).forEach(ip => {
          W(`  ${U.pad(ip, 22)}${U.pad(dev.arp[ip].mac.toLowerCase().replace(/\./g, '-').replace(/(..)(..)-(..)(..)-(..)(..)/, '$1-$2-$3-$4-$5-$6'), 22)}dynamic`);
        });
        if (!Object.keys(dev.arp).length) W('  (vazio)');
        return ctx.done();
      }

      case 'nslookup': {
        const name = args[1];
        if (!name) { W('Usage: nslookup <nome>'); return ctx.done(); }
        W(`Server:  ${dev.dns || '(nenhum servidor DNS configurado)'}`);
        PT.engine.resolve(dev, name, ip => {
          if (ip) { W(`Name:    ${name}`); W(`Address: ${ip}`); }
          else W(`*** ${dev.dns || 'DNS'} can't find ${name}: Non-existent domain`);
          ctx.done();
        });
        return;
      }

      default:
        W(`'${args[0]}' is not recognized as an internal or external command.`);
        return ctx.done();
    }
  };

  HostShell.prototype.ipconfig = function (args, ctx) {
    const dev = this.dev, W = ctx.write;
    const opt = (args[0] || '').toLowerCase();

    if (opt === '/renew') {
      W('Solicitando endereço via DHCP...');
      dev.dhcpMode = true;
      PT.engine.dhcpStart(dev, res => {
        if (res.ok) {
          W(`\nIP Address......................: ${res.ip}`);
          W(`Subnet Mask.....................: ${res.mask}`);
          W(`Default Gateway.................: ${res.gw || '0.0.0.0'}`);
          W(`DNS Server......................: ${res.dns || '0.0.0.0'}`);
        } else {
          W('DHCP falhou: não foi possível contatar um servidor DHCP.');
        }
        if (PT.ui) PT.ui.refresh();
        ctx.done();
      });
      return;
    }
    if (opt === '/release') {
      dev.ports.forEach(p => { if (p.kind !== 'vlan') { p.ip = ''; p.mask = ''; } });
      dev.gateway = '';
      W('Endereço IP liberado.');
      if (PT.ui) PT.ui.refresh();
      return ctx.done();
    }

    const all = opt === '/all';
    dev.ports.filter(p => p.kind !== 'vlan').forEach(p => {
      W(`\n${p.name} Connection:(default port)\n`);
      if (all) {
        W(`   Physical Address................: ${p.mac.replace(/\./g, '').replace(/(..)(?=.)/g, '$1-').toUpperCase()}`);
        W(`   DHCP Enabled....................: ${dev.dhcpMode ? 'Yes' : 'No'}`);
      }
      W('   Link-local IPv6 Address.........: ::');
      W(`   IPv4 Address....................: ${p.ip || '0.0.0.0'}${p.ipConflict ? '  (Duplicado — conflito de IP na rede)' : ''}`);
      W(`   Subnet Mask.....................: ${p.mask || '0.0.0.0'}`);
      W(`   Default Gateway.................: ${dev.gateway || '0.0.0.0'}`);
      if (all) W(`   DNS Servers.....................: ${dev.dns || '0.0.0.0'}`);
    });
    ctx.done();
  };

  /* ======================================================================
     IosShell — Cisco IOS (roteador / switch)
     ====================================================================== */
  function IosShell(dev) {
    this.dev = dev;
    if (!dev.cliState) dev.cliState = { mode: 'user', ctx: null };
  }

  IosShell.prototype.prompt = function () {
    const d = this.dev, st = d.cliState;
    switch (st.mode) {
      case 'user': return d.name + '>';
      case 'priv': return d.name + '#';
      case 'config': return d.name + '(config)#';
      case 'if': return d.name + '(config-if)#';
      case 'vlan': return d.name + '(config-vlan)#';
      case 'line': return d.name + '(config-line)#';
      default: return d.name + '>';
    }
  };

  IosShell.prototype.exec = function (line, ctx) {
    const dev = this.dev, st = dev.cliState, W = ctx.write;
    const raw = line.trim();
    if (!raw) return ctx.done();
    let toks = raw.split(/\s+/);
    let no = false;
    if (U.abbrev(toks[0], 'no') && toks.length > 1) { no = true; toks = toks.slice(1); }
    const c = toks[0].toLowerCase();
    const rest = toks.slice(1);
    const changed = () => { PT.engine.topologyChanged(); if (PT.ui) PT.ui.refresh(); };

    /* ------------------------ comandos válidos em qualquer modo ------------ */
    if (U.abbrev(c, 'end')) { st.mode = st.mode === 'user' ? 'user' : 'priv'; st.ctx = null; return ctx.done(); }
    if (U.abbrev(c, 'exit')) {
      if (st.mode === 'if' || st.mode === 'vlan' || st.mode === 'line') { st.mode = 'config'; st.ctx = null; }
      else if (st.mode === 'config') st.mode = 'priv';
      else if (st.mode === 'priv') st.mode = 'user';
      else W('(sessão encerrada)');
      return ctx.done();
    }
    if (c === '?') { W(helpFor(st.mode)); return ctx.done(); }

    /* --------------------------------- modo usuário -------------------- */
    if (st.mode === 'user') {
      if (U.abbrev(c, 'enable')) {
        st.mode = 'priv'; return ctx.done();
      }
      if (U.abbrev(c, 'ping')) return this.ping(rest, ctx);
      if (U.abbrev(c, 'show')) return this.show(rest, ctx);
      if (U.abbrev(c, 'traceroute')) return this.trace(rest, ctx);
      W(INVALID); return ctx.done();
    }

    /* ------------------------------- modo privilegiado ------------------ */
    if (st.mode === 'priv') {
      if (U.abbrev(c, 'disable')) { st.mode = 'user'; return ctx.done(); }
      if (U.abbrev(c, 'configure')) {
        if (!rest.length || U.abbrev(rest[0], 'terminal')) {
          st.mode = 'config';
          W('Enter configuration commands, one per line.  End with CNTL/Z.');
          return ctx.done();
        }
        W(INVALID); return ctx.done();
      }
      if (U.abbrev(c, 'show')) return this.show(rest, ctx);
      if (U.abbrev(c, 'ping')) return this.ping(rest, ctx);
      if (U.abbrev(c, 'traceroute')) return this.trace(rest, ctx);
      if (U.abbrev(c, 'clear')) {
        if (rest[0] && U.abbrev(rest[0], 'mac')) { dev.macTable = {}; W('Tabela MAC limpa.'); }
        else if (rest[0] && U.abbrev(rest[0], 'arp')) { dev.arp = {}; W('Cache ARP limpo.'); }
        else W(INVALID);
        return ctx.done();
      }
      if (U.abbrev(c, 'copy') || U.abbrev(c, 'write')) {
        W('Building configuration...');
        PT.engine.after(400, () => { W('[OK]'); ctx.done(); });
        return;
      }
      if (U.abbrev(c, 'reload')) { W('Proceed with reload? [confirm]'); W('(simulação: dispositivo reiniciado)'); PT.model.resetRuntime(dev); changed(); return ctx.done(); }
      W(INVALID); return ctx.done();
    }

    /* --------------------------------- modo global config --------------- */
    if (st.mode === 'config') {
      if (U.abbrev(c, 'hostname')) {
        if (!rest.length) { W(INCOMPLETE); return ctx.done(); }
        dev.name = rest[0]; changed(); return ctx.done();
      }
      if (U.abbrev(c, 'interface')) {
        const name = normIf(dev, rest);
        if (!name) { W('% Invalid interface'); return ctx.done(); }
        st.mode = 'if'; st.ctx = name; return ctx.done();
      }
      if (U.abbrev(c, 'ip')) {
        if (rest[0] && U.abbrev(rest[0], 'route')) return this.ipRoute(rest.slice(1), no, ctx);
        if (rest[0] && U.abbrev(rest[0], 'default-gateway')) {
          dev.gateway = no ? '' : (rest[1] || ''); changed(); return ctx.done();
        }
        W(INVALID); return ctx.done();
      }
      if (U.abbrev(c, 'vlan')) {
        const id = parseInt(rest[0], 10);
        if (!id || id < 1 || id > 4094) { W('% Invalid VLAN id'); return ctx.done(); }
        if (no) { delete dev.vlans[id]; changed(); return ctx.done(); }
        if (!dev.vlans[id]) dev.vlans[id] = 'VLAN' + String(id).padStart(4, '0');
        st.mode = 'vlan'; st.ctx = id; changed(); return ctx.done();
      }
      if (U.abbrev(c, 'enable')) {
        if (rest[0] && (U.abbrev(rest[0], 'secret') || U.abbrev(rest[0], 'password'))) {
          dev.enableSecret = no ? '' : (rest[1] || '');
          return ctx.done();
        }
      }
      if (U.abbrev(c, 'line')) { st.mode = 'line'; st.ctx = rest.join(' '); return ctx.done(); }
      if (U.abbrev(c, 'banner') || U.abbrev(c, 'service') || U.abbrev(c, 'spanning-tree')) return ctx.done();
      W(INVALID); return ctx.done();
    }

    /* ------------------------------ modo de interface ------------------- */
    if (st.mode === 'if') {
      const port = M.getPort(dev, st.ctx);
      if (!port) { st.mode = 'config'; W('% Interface inválida'); return ctx.done(); }

      if (U.abbrev(c, 'ip')) {
        if (rest[0] && U.abbrev(rest[0], 'address')) {
          if (no) { port.ip = ''; port.mask = ''; changed(); return ctx.done(); }
          const ip = rest[1], mask = rest[2];
          if (!ip || !mask) { W(INCOMPLETE); return ctx.done(); }
          if (!U.isValidIp(ip)) { W('% Invalid input detected — endereço IP inválido'); return ctx.done(); }
          if (!U.isValidMask(mask)) { W('% Invalid input detected — máscara inválida'); return ctx.done(); }
          const problema = U.hostAddrProblem(ip, mask);
          if (problema === 'rede') {
            W(`% ${ip} is the subnet address for mask ${mask} — não pode ser usado numa interface.`);
            W('  Refaça o cálculo da sub-rede e informe um endereço de host válido.');
            return ctx.done();
          }
          if (problema === 'broadcast') {
            W(`% ${ip} is the broadcast address for mask ${mask} — não pode ser usado numa interface.`);
            W('  Refaça o cálculo da sub-rede e informe um endereço de host válido.');
            return ctx.done();
          }
          const dup = S.list().find(d => d !== dev && d.ports.some(p => p.ip === ip));
          if (dup) W(`% ${ip} overlaps with ${dup.name}`);
          port.ip = ip; port.mask = mask; port.ipConflict = false; changed(); return ctx.done();
        }
        W(INVALID); return ctx.done();
      }
      if (U.abbrev(c, 'shutdown')) {
        port.shutdown = !no;
        const [s, p] = ifStatus(dev, port);
        W(`%LINK-5-CHANGED: Interface ${port.name}, changed state to ${port.shutdown ? 'administratively down' : s}`);
        if (!port.shutdown) W(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${port.name}, changed state to ${p}`);
        changed(); return ctx.done();
      }
      if (U.abbrev(c, 'description')) { port.description = no ? '' : rest.join(' '); return ctx.done(); }
      if (U.abbrev(c, 'clock')) {
        if (rest[0] && U.abbrev(rest[0], 'rate')) {
          port.clockRate = no ? 0 : (parseInt(rest[1], 10) || 0);
          changed(); return ctx.done();
        }
      }
      if (U.abbrev(c, 'bandwidth')) { port.bandwidth = parseInt(rest[0], 10) || port.bandwidth; return ctx.done(); }
      if (U.abbrev(c, 'switchport')) {
        if (dev.type !== 'switch') { W(INVALID); return ctx.done(); }
        if (rest[0] && U.abbrev(rest[0], 'mode')) {
          const m = (rest[1] || '').toLowerCase();
          if (U.abbrev(m, 'access')) port.mode = 'access';
          else if (U.abbrev(m, 'trunk')) port.mode = 'trunk';
          else { W(INVALID); return ctx.done(); }
          changed(); return ctx.done();
        }
        if (rest[0] && U.abbrev(rest[0], 'access')) {
          if (rest[1] && U.abbrev(rest[1], 'vlan')) {
            const id = parseInt(rest[2], 10);
            if (!id) { W(INCOMPLETE); return ctx.done(); }
            if (!dev.vlans[id]) { dev.vlans[id] = 'VLAN' + String(id).padStart(4, '0'); W(`% Access VLAN does not exist. Creating vlan ${id}`); }
            port.vlan = id; port.mode = 'access'; changed(); return ctx.done();
          }
        }
        if (rest[0] && U.abbrev(rest[0], 'trunk')) {
          if (rest[1] && U.abbrev(rest[1], 'native') && rest[2] && U.abbrev(rest[2], 'vlan')) {
            port.nativeVlan = parseInt(rest[3], 10) || 1; changed(); return ctx.done();
          }
          return ctx.done();
        }
        W(INVALID); return ctx.done();
      }
      if (U.abbrev(c, 'duplex') || U.abbrev(c, 'speed')) return ctx.done();
      if (U.abbrev(c, 'interface')) {                       // troca direta de interface
        const name = normIf(dev, rest);
        if (!name) { W('% Invalid interface'); return ctx.done(); }
        st.ctx = name; return ctx.done();
      }
      W(INVALID); return ctx.done();
    }

    /* ------------------------------------ modo VLAN / LINE -------------- */
    if (st.mode === 'vlan') {
      if (U.abbrev(c, 'name')) { dev.vlans[st.ctx] = rest[0] || dev.vlans[st.ctx]; changed(); return ctx.done(); }
      W(INVALID); return ctx.done();
    }
    if (st.mode === 'line') {
      if (U.abbrev(c, 'password') || U.abbrev(c, 'login') || U.abbrev(c, 'logging') || U.abbrev(c, 'transport')) return ctx.done();
      W(INVALID); return ctx.done();
    }
    W(INVALID); ctx.done();
  };

  IosShell.prototype.ipRoute = function (a, no, ctx) {
    const dev = this.dev, W = ctx.write;
    if (dev.type !== 'router') { W('% Comando disponível apenas em roteadores'); return ctx.done(); }
    if (a.length < 3) { W(INCOMPLETE); return ctx.done(); }
    const [net, mask, nh] = a;
    if (!U.isValidIp(net) || !U.isValidMask(mask)) { W(INVALID); return ctx.done(); }
    if (no) {
      dev.staticRoutes = dev.staticRoutes.filter(r => !(r.net === net && r.mask === mask));
    } else {
      const iface = U.isValidIp(nh) ? null : normIf(dev, [nh]);
      if (!U.isValidIp(nh) && !iface) { W('% Invalid next hop address'); return ctx.done(); }
      dev.staticRoutes = dev.staticRoutes.filter(r => !(r.net === net && r.mask === mask && r.nh === nh));
      dev.staticRoutes.push({ net: U.networkOf(net, mask), mask, nh: iface ? null : nh, iface });
    }
    PT.engine.topologyChanged();
    if (PT.ui) PT.ui.refresh();
    ctx.done();
  };

  IosShell.prototype.ping = function (a, ctx) {
    const t = a[0];
    if (!t) { ctx.write('Protocol [ip]: Target IP address:'); return ctx.done(); }
    PT.engine.ping(this.dev, t, { count: 5, size: 100, ios: true, interval: 300 },
      { onLine: ctx.write, onDone: () => ctx.done() });
  };

  IosShell.prototype.trace = function (a, ctx) {
    const t = a[0];
    if (!t) { ctx.write(INCOMPLETE); return ctx.done(); }
    PT.engine.trace(this.dev, t, {}, { onLine: ctx.write, onDone: () => ctx.done() });
  };

  /* ------------------------------------------------------------- show ... */
  IosShell.prototype.show = function (a, ctx) {
    const dev = this.dev, W = ctx.write;
    if (!a.length) { W(INCOMPLETE); return ctx.done(); }
    const k = a[0].toLowerCase();

    if (U.abbrev(k, 'version')) {
      W(`Cisco IOS Software, ${dev.model} Software, Version 15.1(4)M4 (simulado)`);
      W(`${dev.name} uptime is ${Math.round(PT.engine.clock / 1000)} seconds`);
      W(`Processor board ID NETSIM-${dev.id.slice(-6).toUpperCase()}`);
      return ctx.done();
    }

    if (U.abbrev(k, 'running-config') || U.abbrev(k, 'startup-config')) {
      W('Building configuration...\n');
      W(runningConfig(dev));
      return ctx.done();
    }

    if (U.abbrev(k, 'ip')) {
      const k2 = (a[1] || '').toLowerCase();
      if (U.abbrev(k2, 'interface')) {
        if (a[2] && U.abbrev(a[2], 'brief')) return this.showIpBrief(ctx);
        return this.showIpBrief(ctx);
      }
      if (U.abbrev(k2, 'route')) return this.showIpRoute(ctx);
      if (U.abbrev(k2, 'arp')) return this.showArp(ctx);
      W(INVALID); return ctx.done();
    }

    if (U.abbrev(k, 'interfaces')) return this.showInterfaces(a.slice(1), ctx);
    if (U.abbrev(k, 'arp')) return this.showArp(ctx);

    if (U.abbrev(k, 'mac')) {                      // show mac address-table
      W('          Mac Address Table');
      W('-------------------------------------------\n');
      W('Vlan    Mac Address       Type        Ports');
      W('----    -----------       --------    -----');
      Object.keys(dev.macTable).forEach(mac => {
        const e = dev.macTable[mac];
        W(`${U.padL(e.vlan, 4)}    ${mac.toLowerCase()}    DYNAMIC     ${shortIf(e.port)}`);
      });
      return ctx.done();
    }

    if (U.abbrev(k, 'vlan')) {
      W('VLAN Name                             Status    Ports');
      W('---- -------------------------------- --------- -------------------------------');
      Object.keys(dev.vlans).sort((x, y) => x - y).forEach(id => {
        const ports = M.physicalPorts(dev).filter(p => p.mode === 'access' && p.vlan == id).map(p => shortIf(p.name));
        W(`${U.pad(id, 5)}${U.pad(dev.vlans[id], 33)}${U.pad('active', 10)}${ports.join(', ')}`);
      });
      return ctx.done();
    }

    if (U.abbrev(k, 'sessions') || U.abbrev(k, 'clock')) { W(new Date().toString()); return ctx.done(); }
    W(INVALID); ctx.done();
  };

  IosShell.prototype.showIpBrief = function (ctx) {
    const dev = this.dev, W = ctx.write;
    W('Interface              IP-Address      OK? Method Status                Protocol');
    dev.ports.forEach(p => {
      const [s, pr] = ifStatus(dev, p);
      W(`${U.pad(p.name, 23)}${U.pad(p.ip || 'unassigned', 16)}${U.pad(p.ip ? 'YES' : 'YES', 4)}${U.pad(p.ip ? 'manual' : 'unset', 7)}${U.pad(s, 22)}${pr}` +
        (p.ipConflict ? '   << endereço duplicado' : ''));
    });
    ctx.done();
  };

  IosShell.prototype.showIpRoute = function (ctx) {
    const dev = this.dev, W = ctx.write;
    const rs = PT.engine.routes(dev);
    W('Codes: C - connected, S - static, L - local, * - candidate default\n');
    const def = rs.find(r => r.type === 'S*');
    W(def ? `Gateway of last resort is ${def.nh || '0.0.0.0'} to network 0.0.0.0\n` : 'Gateway of last resort is not set\n');
    rs.filter(r => r.type === 'C').forEach(r => {
      W(`C    ${r.net}/${U.maskToPrefix(r.mask)} is directly connected, ${r.iface}`);
      const p = M.getPort(dev, r.iface);
      if (p) W(`L    ${p.ip}/32 is directly connected, ${r.iface}`);
    });
    rs.filter(r => r.type !== 'C').forEach(r => {
      W(`${r.type === 'S*' ? 'S*  ' : 'S   '} ${r.net}/${U.maskToPrefix(r.mask)} [1/0] via ${r.nh || 'directly connected'}${r.iface ? ', ' + r.iface : ''}`);
    });
    if (!rs.length) W('(nenhuma rota — configure endereços IP nas interfaces)');
    ctx.done();
  };

  IosShell.prototype.showArp = function (ctx) {
    const dev = this.dev, W = ctx.write;
    W('Protocol  Address          Age (min)  Hardware Addr   Type   Interface');
    dev.ports.filter(p => p.ip).forEach(p => {
      W(`Internet  ${U.pad(p.ip, 17)}${U.pad('-', 11)}${p.mac.toLowerCase()}  ARPA   ${p.name}`);
    });
    Object.keys(dev.arp).forEach(ip => {
      const e = dev.arp[ip];
      W(`Internet  ${U.pad(ip, 17)}${U.pad(Math.round((PT.engine.clock - e.ts) / 60000), 11)}${e.mac.toLowerCase()}  ARPA   ${e.port}`);
    });
    ctx.done();
  };

  IosShell.prototype.showInterfaces = function (a, ctx) {
    const dev = this.dev, W = ctx.write;
    const only = a.length ? normIf(dev, a) : null;
    dev.ports.filter(p => !only || p.name === only).forEach(p => {
      const [s, pr] = ifStatus(dev, p);
      W(`${p.name} is ${s}, line protocol is ${pr} ${M.isPortUp(dev, p) ? '(connected)' : ''}`);
      W(`  Hardware is ${p.kind === 'serial' ? 'HD64570' : 'PQUICC'}, address is ${(p.mac || 'n/a').toLowerCase()}`);
      if (p.description) W(`  Description: ${p.description}`);
      W(p.ip ? `  Internet address is ${p.ip}/${U.maskToPrefix(p.mask)}` : '  Internet protocol processing disabled');
      W(`  MTU 1500 bytes, BW ${p.bandwidth} Kbit/sec, DLY 100 usec`);
      if (p.kind === 'serial') {
        const l = M.linkOf(p);
        const isDce = l && ((l.dce === 'a' && l.a.port === p.name && l.a.dev === dev.id) || (l.dce === 'b' && l.b.port === p.name && l.b.dev === dev.id));
        W(`  Encapsulation HDLC, ${isDce ? 'DCE' : 'DTE'}${isDce ? ', clock rate ' + (p.clockRate || 'não configurado') : ''}`);
      } else {
        W('  Encapsulation ARPA, loopback not set');
      }
      W(`  ${p.rx} packets input, ${p.tx} packets output`);
      W('');
    });
    ctx.done();
  };

  /* ------------------------------------------------------- running-config */
  function runningConfig(dev) {
    const L = [];
    L.push('!', 'version 15.1', 'no service timestamps log datetime msec', '!');
    L.push('hostname ' + dev.name);
    if (dev.enableSecret) L.push('enable secret ' + dev.enableSecret);
    L.push('!');
    if (dev.type === 'switch') {
      Object.keys(dev.vlans).filter(v => v != 1).forEach(v => { L.push(`vlan ${v}`, ` name ${dev.vlans[v]}`, '!'); });
    }
    dev.ports.forEach(p => {
      L.push('interface ' + p.name);
      if (p.description) L.push(' description ' + p.description);
      if (dev.type === 'switch' && p.kind === 'copper') {
        if (p.mode === 'trunk') L.push(' switchport mode trunk');
        else if (p.vlan !== 1) L.push(` switchport access vlan ${p.vlan}`, ' switchport mode access');
      }
      if (p.ip) L.push(` ip address ${p.ip} ${p.mask}`);
      else if (p.kind !== 'vlan' && dev.type === 'router') L.push(' no ip address');
      if (p.kind === 'serial' && p.clockRate) L.push(' clock rate ' + p.clockRate);
      if (p.shutdown) L.push(' shutdown');
      L.push('!');
    });
    (dev.staticRoutes || []).forEach(r => L.push(`ip route ${r.net} ${r.mask} ${r.nh || r.iface}`));
    if (dev.type !== 'router' && dev.gateway) L.push('ip default-gateway ' + dev.gateway);
    L.push('!', 'line con 0', ' logging synchronous', '!', 'end');
    return L.join('\n');
  }

  function helpFor(mode) {
    const common = 'exit  end  ?';
    switch (mode) {
      case 'user': return 'enable  ping  traceroute  show  ' + common;
      case 'priv': return 'configure terminal  show ...  ping  traceroute  clear mac address-table  copy running-config startup-config  disable  ' + common;
      case 'config': return 'hostname  interface <if>  ip route <rede> <máscara> <próximo-salto>  ip default-gateway  vlan <id>  enable secret  line  ' + common;
      case 'if': return 'ip address <ip> <máscara>  no shutdown  shutdown  description  clock rate  switchport mode access|trunk  switchport access vlan <id>  ' + common;
      case 'vlan': return 'name <nome>  ' + common;
      default: return common;
    }
  }

  PT.cli = {
    createShell(dev) {
      return (dev.type === 'router' || dev.type === 'switch') ? new IosShell(dev) : new HostShell(dev);
    },
    runningConfig, shortIf, normIf, ifStatus
  };
})(window);
