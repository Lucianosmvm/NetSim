/* ==========================================================================
   model.js — modelo de dados: dispositivos, portas, cabos e o "store"
   ========================================================================== */
(function (global) {
  'use strict';
  const PT = global.PT;
  const U = PT.util;

  /* ------------------------------------------------------------------
     Definição dos tipos de dispositivo
     kind da porta: 'copper' (ethernet), 'serial', 'vlan' (SVI virtual)
     ------------------------------------------------------------------ */
  const DEVICE_DEFS = {
    router: {
      label: 'Roteador', model: 'ISR 1941', group: 'net', klass: 'l3', prefix: 'Router',
      ports: [
        { name: 'GigabitEthernet0/0', kind: 'copper', shutdown: true },
        { name: 'GigabitEthernet0/1', kind: 'copper', shutdown: true },
        { name: 'Serial0/0/0', kind: 'serial', shutdown: true },
        { name: 'Serial0/0/1', kind: 'serial', shutdown: true }
      ]
    },
    switch: {
      label: 'Switch', model: 'Catalyst 2960', group: 'net', klass: 'l2', prefix: 'Switch',
      ports: (function () {
        const a = [];
        for (let i = 1; i <= 8; i++) a.push({ name: 'FastEthernet0/' + i, kind: 'copper', shutdown: false, mode: 'access', vlan: 1 });
        a.push({ name: 'GigabitEthernet0/1', kind: 'copper', shutdown: false, mode: 'access', vlan: 1 });
        a.push({ name: 'GigabitEthernet0/2', kind: 'copper', shutdown: false, mode: 'access', vlan: 1 });
        a.push({ name: 'Vlan1', kind: 'vlan', shutdown: false, vlan: 1 });
        return a;
      })()
    },
    hub: {
      label: 'Hub', model: 'PT-Hub', group: 'net', klass: 'l1', prefix: 'Hub',
      ports: (function () {
        const a = [];
        for (let i = 0; i < 6; i++) a.push({ name: 'Ethernet' + i, kind: 'copper', shutdown: false });
        return a;
      })()
    },
    pc: {
      label: 'PC', model: 'PC-PT', group: 'end', klass: 'host', prefix: 'PC',
      ports: [{ name: 'FastEthernet0', kind: 'copper', shutdown: false }]
    },
    laptop: {
      label: 'Notebook', model: 'Laptop-PT', group: 'end', klass: 'host', prefix: 'Laptop',
      ports: [{ name: 'FastEthernet0', kind: 'copper', shutdown: false }]
    },
    server: {
      label: 'Servidor', model: 'Server-PT', group: 'end', klass: 'host', prefix: 'Server',
      ports: [{ name: 'FastEthernet0', kind: 'copper', shutdown: false }]
    }
  };

  /* ------------------------------------------------------------------ store */
  const store = {
    devices: {},          // id -> device
    links: {},            // id -> link
    counters: {},         // prefixo -> próximo número
    list() { return Object.values(this.devices); },
    linkList() { return Object.values(this.links); },
    dev(id) { return this.devices[id]; },
    byName(name) { return this.list().find(d => d.name.toLowerCase() === String(name).toLowerCase()); }
  };

  function nextName(prefix) {
    if (store.counters[prefix] === undefined) store.counters[prefix] = 0;
    const n = store.counters[prefix]++;
    return prefix + n;
  }

  function makePort(spec) {
    return {
      name: spec.name,
      kind: spec.kind,
      mac: spec.kind === 'serial' ? '' : U.nextMac(),
      ip: '',
      mask: '',
      shutdown: !!spec.shutdown,
      ipConflict: false,          // endereço duplicado detectado por ARP gratuito
      description: '',
      link: null,                        // id do cabo
      mode: spec.mode || 'access',       // switch: access | trunk
      vlan: spec.vlan || 1,
      nativeVlan: 1,
      clockRate: 0,                      // serial DCE
      bandwidth: spec.kind === 'serial' ? 1544 : 100000,
      rx: 0, tx: 0
    };
  }

  function createDevice(type, x, y, name) {
    const def = DEVICE_DEFS[type];
    if (!def) throw new Error('Tipo desconhecido: ' + type);
    const dev = {
      id: U.uid('dev'),
      type, x: Math.round(x), y: Math.round(y),
      name: name || nextName(def.prefix),
      model: def.model,
      klass: def.klass,
      ports: def.ports.map(makePort),
      gateway: '',
      dns: '',
      dhcpMode: false,             // hosts: obter IP automaticamente
      staticRoutes: [],            // roteador: {net, mask, nh, iface}
      vlans: { 1: 'default' },     // switch
      macTable: {},                // switch: mac -> {port, vlan, ts}
      arp: {},                     // ip -> {mac, port, ts}
      pendingArp: {},              // ip -> [callbacks]
      echoWait: {},                // "id:seq" -> {t0, cb}
      services: {
        dhcp: { on: false, start: '', mask: '255.255.255.0', gw: '', dns: '', count: 50, leases: {} },
        dns: { on: false, records: {} },
        http: { on: true }
      },
      enableSecret: '',
      cliState: { mode: 'user', ctx: null, buf: [] },
      _hist: []
    };
    // roteador só ganha MAC nas portas de cobre (serial usa HDLC)
    store.devices[dev.id] = dev;
    return dev;
  }

  function removeDevice(id) {
    const dev = store.dev(id);
    if (!dev) return;
    store.linkList().filter(l => l.a.dev === id || l.b.dev === id).forEach(l => removeLink(l.id));
    delete store.devices[id];
  }

  function getPort(dev, name) {
    if (!dev || !name) return null;
    const n = String(name).toLowerCase();
    return dev.ports.find(p => p.name.toLowerCase() === n) || null;
  }

  function physicalPorts(dev) { return dev.ports.filter(p => p.kind !== 'vlan'); }
  function freePorts(dev) { return physicalPorts(dev).filter(p => !p.link); }

  /* ------------------------------------------------------------------ cabos */

  /** Grupos para regra de cabo direto/crossover (igual ao Packet Tracer). */
  function cableGroup(dev) {
    if (dev.type === 'switch' || dev.type === 'hub') return 'B';   // repetidores/comutadores
    return 'A';                                                    // PC, notebook, servidor, roteador
  }

  function cableRequired(devA, devB) {
    return cableGroup(devA) === cableGroup(devB) ? 'crossover' : 'straight';
  }

  function createLink(devA, portA, devB, portB, cable) {
    if (portA.link || portB.link) return { error: 'Uma das portas já está ocupada.' };
    if (devA.id === devB.id) return { error: 'Não é possível conectar o dispositivo nele mesmo.' };

    const serialPair = portA.kind === 'serial' && portB.kind === 'serial';
    if ((portA.kind === 'serial') !== (portB.kind === 'serial'))
      return { error: 'Porta serial só conecta em outra porta serial.' };

    let type = cable;
    if (cable === 'auto') type = serialPair ? 'serial' : cableRequired(devA, devB);
    if (serialPair && type !== 'serial') type = 'serial';
    if (!serialPair && type === 'serial') return { error: 'Cabo serial exige portas seriais nos dois lados.' };

    const link = {
      id: U.uid('lnk'),
      a: { dev: devA.id, port: portA.name },
      b: { dev: devB.id, port: portB.name },
      cable: type,
      dce: serialPair ? 'a' : null      // ponta A é o DCE (fornece clock)
    };
    portA.link = link.id;
    portB.link = link.id;
    store.links[link.id] = link;
    return { link };
  }

  function removeLink(id) {
    const l = store.links[id];
    if (!l) return;
    const pa = getPort(store.dev(l.a.dev), l.a.port);
    const pb = getPort(store.dev(l.b.dev), l.b.port);
    if (pa) pa.link = null;
    if (pb) pb.link = null;
    delete store.links[id];
  }

  function linkEnds(link) {
    return {
      da: store.dev(link.a.dev), pa: getPort(store.dev(link.a.dev), link.a.port),
      db: store.dev(link.b.dev), pb: getPort(store.dev(link.b.dev), link.b.port)
    };
  }

  /** Cabo correto para os dois dispositivos? (false => link fica "down") */
  function cableOk(link) {
    const e = linkEnds(link);
    if (!e.da || !e.db || !e.pa || !e.pb) return false;
    if (link.cable === 'serial') return e.pa.kind === 'serial' && e.pb.kind === 'serial';
    return link.cable === cableRequired(e.da, e.db);
  }

  /** Estado do enlace: up somente se cabo certo, portas ativas e clock no DCE. */
  function linkUp(link) {
    const e = linkEnds(link);
    if (!e.pa || !e.pb) return false;
    if (!cableOk(link)) return false;
    if (e.pa.shutdown || e.pb.shutdown) return false;
    if (link.cable === 'serial') {
      const dce = link.dce === 'a' ? e.pa : e.pb;
      if (!dce.clockRate) return false;   // "Serial0/0/0 is up, line protocol is down"
    }
    return true;
  }

  function linkOf(port) { return port && port.link ? store.links[port.link] : null; }

  /** Vizinho do outro lado da porta: {dev, port} ou null. */
  function neighbor(dev, port) {
    const l = linkOf(port);
    if (!l) return null;
    const mine = (l.a.dev === dev.id && l.a.port === port.name) ? 'a' : 'b';
    const other = mine === 'a' ? l.b : l.a;
    const d = store.dev(other.dev);
    return d ? { dev: d, port: getPort(d, other.port), link: l } : null;
  }

  function isPortUp(dev, port) {
    if (!port || port.shutdown) return false;
    if (port.kind === 'vlan') {
      // SVI sobe se alguma porta de acesso da mesma VLAN estiver operacional
      return physicalPorts(dev).some(p => p.vlan === port.vlan && !p.shutdown && linkOf(p) && linkUp(linkOf(p)));
    }
    const l = linkOf(port);
    return !!(l && linkUp(l));
  }

  function ownIps(dev) {
    return dev.ports.filter(p => p.ip && isPortUp(dev, p)).map(p => ({ port: p, ip: p.ip, mask: p.mask }));
  }

  function hasIp(dev, ip) { return dev.ports.some(p => p.ip === ip && isPortUp(dev, p)); }

  function portByIp(dev, ip) { return dev.ports.find(p => p.ip === ip) || null; }

  /* ------------------------------------------------------------------ reset/serialização */
  function resetRuntime(dev) {
    dev.arp = {}; dev.pendingArp = {}; dev.echoWait = {}; dev._probe = {};
    dev.ports.forEach(p => { p.ipConflict = false; p._annState = undefined; });
    dev.macTable = {};
    dev.cliState = { mode: 'user', ctx: null, buf: [] };
  }

  function serialize() {
    return {
      version: 1,
      counters: store.counters,
      devices: store.list().map(d => ({
        id: d.id, type: d.type, name: d.name, x: d.x, y: d.y, model: d.model, klass: d.klass,
        gateway: d.gateway, dns: d.dns, dhcpMode: d.dhcpMode,
        staticRoutes: d.staticRoutes, vlans: d.vlans, services: d.services,
        enableSecret: d.enableSecret,
        ports: d.ports.map(p => ({
          name: p.name, kind: p.kind, mac: p.mac, ip: p.ip, mask: p.mask, shutdown: p.shutdown,
          description: p.description, link: p.link, mode: p.mode, vlan: p.vlan,
          nativeVlan: p.nativeVlan, clockRate: p.clockRate, bandwidth: p.bandwidth
        }))
      })),
      links: store.linkList()
    };
  }

  function load(data) {
    store.devices = {}; store.links = {}; store.counters = data.counters || {};
    (data.devices || []).forEach(d => {
      const dev = createDevice(d.type, d.x, d.y, d.name);
      delete store.devices[dev.id];              // descarta o id temporário
      dev.id = d.id;
      dev.gateway = d.gateway || '';
      dev.dns = d.dns || '';
      dev.dhcpMode = !!d.dhcpMode;
      dev.staticRoutes = d.staticRoutes || [];
      dev.vlans = d.vlans || { 1: 'default' };
      if (d.services) dev.services = d.services;
      dev.enableSecret = d.enableSecret || '';
      if (d.ports && d.ports.length) {
        dev.ports = d.ports.map(p => Object.assign(makePort(p), p, { rx: 0, tx: 0 }));
      }
      store.devices[dev.id] = dev;
      resetRuntime(dev);
    });
    (data.links || []).forEach(l => { store.links[l.id] = l; });
  }

  PT.model = {
    DEVICE_DEFS, store, createDevice, removeDevice, getPort, physicalPorts, freePorts,
    createLink, removeLink, linkEnds, linkUp, cableOk, cableRequired, cableGroup, linkOf,
    neighbor, isPortUp, ownIps, hasIp, portByIp, resetRuntime, serialize, load, nextName
  };
})(window);
