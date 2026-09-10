/* ==========================================================================
   util.js — funções utilitárias de IP/MAC e helpers gerais
   ========================================================================== */
(function (global) {
  'use strict';
  const PT = global.PT = global.PT || {};

  let seqId = 1;
  function uid(prefix) { return (prefix || 'id') + (seqId++) + '_' + Math.random().toString(36).slice(2, 7); }

  /* ---------------------------------------------------------------- IPv4 */
  function isValidIp(ip) {
    if (typeof ip !== 'string') return false;
    const p = ip.trim().split('.');
    if (p.length !== 4) return false;
    return p.every(o => /^\d{1,3}$/.test(o) && +o >= 0 && +o <= 255);
  }

  function ipToInt(ip) {
    const p = ip.trim().split('.').map(Number);
    return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
  }

  function intToIp(n) {
    n = n >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }

  /** Máscara válida = bits 1 contíguos à esquerda. */
  function isValidMask(mask) {
    if (!isValidIp(mask)) return false;
    const n = ipToInt(mask);
    const inv = (~n) >>> 0;
    return ((inv + 1) & inv) === 0;
  }

  function maskToPrefix(mask) {
    let n = ipToInt(mask), c = 0;
    for (let i = 31; i >= 0; i--) { if ((n >>> i) & 1) c++; else break; }
    return c;
  }

  function prefixToMask(p) {
    p = Math.max(0, Math.min(32, p | 0));
    return intToIp(p === 0 ? 0 : (0xFFFFFFFF << (32 - p)) >>> 0);
  }

  function networkOf(ip, mask) { return intToIp((ipToInt(ip) & ipToInt(mask)) >>> 0); }
  function broadcastOf(ip, mask) { return intToIp((ipToInt(ip) | (~ipToInt(mask) >>> 0)) >>> 0); }
  function sameSubnet(a, b, mask) { return networkOf(a, mask) === networkOf(b, mask); }

  /** Máscara padrão classful — usada quando o usuário digita só o IP. */
  function classfulMask(ip) {
    const first = +ip.split('.')[0];
    if (first < 128) return '255.0.0.0';
    if (first < 192) return '255.255.0.0';
    if (first < 224) return '255.255.255.0';
    return '255.255.255.0';
  }

  /**
   * O endereço serve como IP de host com essa máscara?
   * Retorna null (ok), 'rede' ou 'broadcast'. Não revela nenhum cálculo —
   * o aluno continua tendo que refazer a conta no caderno.
   */
  function hostAddrProblem(ip, mask) {
    if (!isValidIp(ip) || !mask || !isValidMask(mask)) return null;
    const p = maskToPrefix(mask);
    if (p >= 31) return null;                 // /31 e /32 não têm rede/broadcast
    if (ip === networkOf(ip, mask)) return 'rede';
    if (ip === broadcastOf(ip, mask)) return 'broadcast';
    return null;
  }

  function isBroadcastIp(ip) { return ip === '255.255.255.255'; }
  function isMulticastIp(ip) { const f = +ip.split('.')[0]; return f >= 224 && f <= 239; }

  /* ---------------------------------------------------------------- MAC */
  const BCAST_MAC = 'FFFF.FFFF.FFFF';
  let macCounter = 0x0001;
  const macsUsados = new Set();      // MACs já entregues nesta sessão ou vindos de uma topologia carregada

  function macFromCounter(n) {
    const hi = (0x00D0BA + ((n >> 16) & 0xFF)) & 0xFFFFFF;
    const lo = n & 0xFFFF;
    const s = (hi.toString(16).padStart(6, '0') + lo.toString(16).padStart(6, '0')).toUpperCase();
    return s.slice(0, 4) + '.' + s.slice(4, 8) + '.' + s.slice(8, 12);
  }

  /** Caminho inverso: de que contador saiu este MAC? (null se não for do simulador) */
  function macToCounter(mac) {
    const hex = String(mac).replace(/[.:-]/g, '').toUpperCase();
    if (!/^[0-9A-F]{12}$/.test(hex)) return null;
    const bloco = parseInt(hex.slice(0, 6), 16) - 0x00D0BA;
    const lo = parseInt(hex.slice(6), 16);
    if (bloco < 0 || bloco > 0xFF || lo > 0xFFFF) return null;
    return (bloco << 16) | lo;
  }

  /**
   * Registra um MAC que já existe (topologia restaurada do navegador ou de
   * arquivo). Sem isto o contador recomeça do zero a cada recarga da página e
   * dispositivos novos repetem o MAC de dispositivos antigos.
   */
  function reserveMac(mac) {
    if (!mac) return;
    macsUsados.add(String(mac).toUpperCase());
    const n = macToCounter(mac);
    if (n !== null && n > macCounter) macCounter = n;
  }

  /** Gera MAC no formato Cisco: 00D0.BA12.3456 */
  function nextMac() {
    let mac;
    do {
      macCounter += 1 + Math.floor(Math.random() * 3);
      mac = macFromCounter(macCounter);
    } while (macsUsados.has(mac));
    macsUsados.add(mac);
    return mac;
  }

  function isBcastMac(m) { return String(m).toUpperCase() === BCAST_MAC; }

  /* ---------------------------------------------------------------- misc */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
  function padL(s, n) { s = String(s); return ' '.repeat(Math.max(0, n - s.length)) + s; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  /** Abreviação estilo IOS: "conf" casa com "configure". */
  function abbrev(token, word) {
    if (!token) return false;
    return word.toLowerCase().indexOf(token.toLowerCase()) === 0;
  }

  /** Retorna o único comando da lista que casa com o token, ou null. */
  function matchOne(token, words) {
    const hits = words.filter(w => abbrev(token, w));
    if (hits.length === 1) return hits[0];
    if (hits.includes(token.toLowerCase())) return token.toLowerCase();
    return null;
  }

  PT.util = {
    uid, isValidIp, ipToInt, intToIp, isValidMask, maskToPrefix, prefixToMask,
    networkOf, broadcastOf, sameSubnet, classfulMask, isBroadcastIp, isMulticastIp, hostAddrProblem,
    nextMac, reserveMac, isBcastMac, BCAST_MAC, clamp, pad, padL, esc, deepCopy, abbrev, matchOne
  };
})(window);
