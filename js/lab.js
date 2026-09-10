/* ==========================================================================
   lab.js — ponte simulador → laboratório real
     1) gerador dos comandos reais (Windows / Linux / IOS) a partir do que o
        aluno configurou no simulador;
     2) checklist das armadilhas típicas da bancada;
     3) roteiros guiados com verificação automática.
   ========================================================================== */
(function (global) {
  'use strict';
  const PT = global.PT;
  const U = PT.util;
  const M = PT.model;
  const S = M.store;

  /* ======================================================================
     1. GERADOR DE COMANDOS REAIS
     ====================================================================== */

  const NIC = 'Ethernet';          // nome padrão do adaptador no Windows

  function hostCommands(dev) {
    const p = dev.ports[0] || {};
    const blocks = [];

    if (dev.dhcpMode || !p.ip) {
      blocks.push({
        titulo: 'Windows — obter IP automaticamente (DHCP)',
        nota: 'Abra o Prompt de Comando ou PowerShell COMO ADMINISTRADOR.',
        linhas: [
          `netsh interface ipv4 set address name="${NIC}" source=dhcp`,
          `netsh interface ipv4 set dnsservers name="${NIC}" source=dhcp`,
          'ipconfig /release',
          'ipconfig /renew',
          'ipconfig /all'
        ]
      });
    } else {
      blocks.push({
        titulo: 'Windows — endereço IP fixo',
        nota: 'Abra o Prompt de Comando ou PowerShell COMO ADMINISTRADOR. Confira o nome do adaptador com "netsh interface show interface".',
        linhas: [
          `netsh interface ipv4 set address name="${NIC}" source=static address=${p.ip} mask=${p.mask || '255.255.255.0'} gateway=${dev.gateway || 'none'}`,
          dev.dns
            ? `netsh interface ipv4 set dnsservers name="${NIC}" source=static address=${dev.dns} register=none validate=no`
            : `netsh interface ipv4 set dnsservers name="${NIC}" source=dhcp`,
          'ipconfig /all'
        ]
      });
      blocks.push({
        titulo: 'Windows — mesma coisa pela interface gráfica',
        nota: 'Se preferir não usar comandos:',
        linhas: [
          'Win+R → ncpa.cpl → Enter',
          `Botão direito no adaptador "${NIC}" → Propriedades`,
          'Protocolo IP Versão 4 (TCP/IPv4) → Propriedades',
          'Marcar "Usar o seguinte endereço IP":',
          `   Endereço IP ........: ${p.ip}`,
          `   Máscara de sub-rede : ${p.mask || '255.255.255.0'}`,
          `   Gateway padrão .....: ${dev.gateway || '(em branco)'}`,
          dev.dns ? `   Servidor DNS .......: ${dev.dns}` : '   Servidor DNS .......: (automático)',
          'OK → OK'
        ]
      });
    }

    blocks.push({
      titulo: 'Linux (NetworkManager)',
      nota: 'Descubra o nome da conexão com "nmcli con show".',
      linhas: dev.dhcpMode || !p.ip
        ? ['nmcli con mod "Wired connection 1" ipv4.method auto', 'nmcli con up "Wired connection 1"', 'ip addr show']
        : [
          `nmcli con mod "Wired connection 1" ipv4.method manual ipv4.addresses ${p.ip}/${p.mask ? U.maskToPrefix(p.mask) : 24}` +
          (dev.gateway ? ` ipv4.gateway ${dev.gateway}` : '') + (dev.dns ? ` ipv4.dns "${dev.dns}"` : ''),
          'nmcli con up "Wired connection 1"',
          'ip addr show && ip route show'
        ]
    });

    blocks.push({
      titulo: 'Liberar o ping (ICMP) no firewall do Windows',
      nota: 'Sem isto o PC responde "Esgotado o tempo limite" mesmo com o IP correto. Executar como administrador.',
      linhas: [
        'netsh advfirewall firewall add rule name="Permitir ping ICMPv4" protocol=icmpv4:8,any dir=in action=allow'
      ]
    });

    const alvos = [];
    const add = ip => { if (ip && ip !== p.ip && alvos.indexOf(ip) < 0 && alvos.length < 4) alvos.push(ip); };
    add(dev.gateway);
    S.list().forEach(d => { if (d !== dev) d.ports.forEach(x => add(x.ip)); });
    blocks.push({
      titulo: 'Testes (iguais aos do simulador)',
      nota: 'Mesma sequência que você acabou de fazer no Desktop do PC.',
      linhas: ['ipconfig /all', 'ping 127.0.0.1']
        .concat(alvos.map(a => 'ping ' + a))
        .concat(['arp -a', alvos[0] ? 'tracert ' + alvos[alvos.length - 1] : 'tracert 8.8.8.8', 'getmac /v'])
    });

    return blocks;
  }

  /** Script IOS pronto para colar no console do equipamento real. */
  function iosScript(dev) {
    const L = ['enable', 'configure terminal', 'hostname ' + dev.name];
    if (dev.type === 'switch') {
      Object.keys(dev.vlans).filter(v => v != 1).forEach(v => {
        L.push('vlan ' + v, ' name ' + dev.vlans[v], ' exit');
      });
    }
    dev.ports.forEach(p => {
      const cfg = [];
      if (p.description) cfg.push(' description ' + p.description);
      if (dev.type === 'switch' && p.kind === 'copper') {
        if (p.mode === 'trunk') cfg.push(' switchport mode trunk');
        else if (p.vlan !== 1) cfg.push(' switchport mode access', ' switchport access vlan ' + p.vlan);
      }
      if (p.ip) cfg.push(` ip address ${p.ip} ${p.mask}`);
      if (p.kind === 'serial' && p.clockRate) cfg.push(' clock rate ' + p.clockRate);
      if (!p.shutdown && p.kind !== 'vlan') cfg.push(' no shutdown');
      if (p.shutdown && p.ip) cfg.push(' shutdown');
      if (!cfg.length) return;
      L.push('interface ' + p.name);
      cfg.forEach(c => L.push(c));
      L.push(' exit');
    });
    (dev.staticRoutes || []).forEach(r => L.push(`ip route ${r.net} ${r.mask} ${r.nh || r.iface}`));
    if (dev.type !== 'router' && dev.gateway) L.push('ip default-gateway ' + dev.gateway);
    L.push('end', 'copy running-config startup-config', '');
    return L;
  }

  function netDeviceCommands(dev) {
    return [
      {
        titulo: 'Como chegar no console do equipamento real',
        nota: 'Switch/roteador Cisco de bancada.',
        linhas: [
          'Cabo console (RJ45 ↔ DB9) ou cabo console USB no equipamento',
          'Instale o driver do adaptador USB-Serial se preciso e veja a porta em: Gerenciador de Dispositivos → Portas (COM e LPT)',
          'Abra o PuTTY → Connection type: Serial → Serial line: COMx → Speed: 9600',
          'Configuração serial: 9600, 8 bits de dados, sem paridade, 1 stop bit, sem controle de fluxo (9600 8N1)',
          'Pressione Enter até aparecer o prompt "Switch>" ou "Router>"'
        ]
      },
      {
        titulo: `Configuração de ${dev.name} — cole linha por linha no console`,
        nota: 'É exatamente o que você configurou no simulador. Cada linha é um comando.',
        linhas: iosScript(dev)
      },
      {
        titulo: 'Conferir depois de aplicar',
        nota: '',
        linhas: dev.type === 'switch'
          ? ['show ip interface brief', 'show vlan brief', 'show mac address-table', 'show running-config']
          : ['show ip interface brief', 'show ip route', 'show running-config']
      },
      {
        titulo: 'Apagar tudo e começar do zero (bancada compartilhada)',
        nota: 'Use quando o equipamento vier com configuração da turma anterior.',
        linhas: dev.type === 'switch'
          ? ['enable', 'erase startup-config', 'delete flash:vlan.dat', 'reload']
          : ['enable', 'erase startup-config', 'reload']
      }
    ];
  }

  function deviceCommands(dev) {
    return dev.klass === 'host' ? hostCommands(dev) : netDeviceCommands(dev);
  }

  /* ======================================================================
     2. ARMADILHAS DA BANCADA
     ====================================================================== */
  const ARMADILHAS = [
    {
      t: 'Prompt sem privilégio de administrador',
      d: 'O comando netsh responde "Acesso negado" ou simplesmente não aplica. Abra o menu Iniciar, digite cmd, clique com o botão direito → Executar como administrador.'
    },
    {
      t: 'Ping não responde mesmo com IP certo',
      d: 'O Firewall do Windows descarta ICMP de entrada, principalmente no perfil "Rede pública". Libere com: netsh advfirewall firewall add rule name="Permitir ping ICMPv4" protocol=icmpv4:8,any dir=in action=allow'
    },
    {
      t: 'Wi-Fi ligado junto com o cabo',
      d: 'O PC pode mandar o tráfego pelo Wi-Fi e o teste falha sem motivo aparente. Desative o adaptador sem fio durante a prática (ncpa.cpl → botão direito → Desativar).'
    },
    {
      t: 'Nome do adaptador diferente de "Ethernet"',
      d: 'Liste os nomes reais com: netsh interface show interface — e use o nome exato entre aspas no comando.'
    },
    {
      t: 'PC pegou 169.254.x.x',
      d: 'É APIPA: o Windows não encontrou servidor DHCP. Confira o cabo, a porta do switch e se o servidor/roteador DHCP está ligado. Depois: ipconfig /release && ipconfig /renew'
    },
    {
      t: 'Dois PCs com o mesmo IP',
      d: 'Aparece "Conflito de endereço IP" e a comunicação fica intermitente. Cada máquina precisa de um endereço diferente na mesma sub-rede.'
    },
    {
      t: 'Máscara diferente entre os PCs',
      d: 'Com máscaras diferentes um enxerga o outro e o outro não. Todos os hosts da mesma rede usam a mesma máscara.'
    },
    {
      t: 'LED de link apagado',
      d: 'Sem link físico não existe configuração que resolva. Troque o cabo, troque a porta do switch e confira se a interface não está desligada (no equipamento Cisco: no shutdown).'
    },
    {
      t: 'Switch não gerenciável',
      d: 'Switch simples de bancada não tem console nem VLAN — a parte de CLI e VLAN só funciona em switch gerenciável (ex.: Catalyst 2960).'
    },
    {
      t: 'Auto-MDIX',
      d: 'Switches modernos aceitam cabo direto ou crossover indiferentemente. A regra direto/crossover continua valendo na teoria e na prova, mas na bancada o cabo direto costuma funcionar em tudo.'
    },
    {
      t: 'Esquecer de salvar no equipamento Cisco',
      d: 'Sem copy running-config startup-config a configuração some no próximo boot.'
    },
    {
      t: 'Antivírus com firewall próprio',
      d: 'Alguns antivírus bloqueiam ICMP mesmo com o firewall do Windows liberado. Se o ping continuar falhando, teste com o antivírus pausado (com autorização do professor).'
    }
  ];

  /* ======================================================================
     3. ROTEIROS GUIADOS
     ====================================================================== */

  /* ---------- auxiliares de verificação ---------- */
  const hosts = () => S.list().filter(d => d.klass === 'host');
  const pcs = () => S.list().filter(d => d.type === 'pc' || d.type === 'laptop');
  const byType = t => S.list().filter(d => d.type === t);
  const devWithIp = ip => S.list().find(d => d.ports.some(p => p.ip === ip));

  function ipMaskOk(ip, mask) {
    const d = devWithIp(ip);
    return !!(d && d.ports.some(p => p.ip === ip && p.mask === mask));
  }
  function gwOk(ip, gw) {
    const d = devWithIp(ip);
    return !!(d && d.gateway === gw);
  }
  function portaAtivaComIp(devType, ip) {
    const d = devWithIp(ip);
    return !!(d && d.type === devType && d.ports.some(p => p.ip === ip && M.isPortUp(d, p)));
  }
  function enlacesAtivos(n) {
    return S.linkList().filter(l => M.linkUp(l)).length >= n;
  }
  function hostsLigados(n) {
    return hosts().filter(h => M.isPortUp(h, h.ports[0])).length >= n;
  }
  function vlanDePorta(swName, portName, vlan) {
    const sw = S.byName(swName) || byType('switch')[0];
    if (!sw) return false;
    const p = M.getPort(sw, portName);
    return !!(p && p.mode === 'access' && p.vlan === vlan);
  }

  /* ---------- montagens iniciais ---------- */
  function limpar() {
    S.devices = {}; S.links = {}; S.counters = {};
    PT.engine.reset();
    if (PT.ui.closeWindows) PT.ui.closeWindows();
  }
  function cabo(a, pa, b, pb) { M.createLink(a, M.getPort(a, pa), b, M.getPort(b, pb), 'auto'); }
  function fim() { PT.engine.topologyChanged(); PT.ui.render(); PT.ui.fitView(); PT.ui.autosave(); }

  function montarLan(qtdPcs) {
    limpar();
    const sw = M.createDevice('switch', 520, 200);
    for (let i = 0; i < qtdPcs; i++) {
      const pc = M.createDevice('pc', 300 + i * 220, 430);
      cabo(pc, 'FastEthernet0', sw, 'FastEthernet0/' + (i + 1));
    }
    fim();
  }

  function montarDuasRedes() {
    limpar();
    const r = M.createDevice('router', 560, 130);
    const sw1 = M.createDevice('switch', 330, 300);
    const sw2 = M.createDevice('switch', 790, 300);
    const pc0 = M.createDevice('pc', 250, 480);
    const pc1 = M.createDevice('pc', 870, 480);
    cabo(r, 'GigabitEthernet0/0', sw1, 'GigabitEthernet0/1');
    cabo(r, 'GigabitEthernet0/1', sw2, 'GigabitEthernet0/1');
    cabo(pc0, 'FastEthernet0', sw1, 'FastEthernet0/1');
    cabo(pc1, 'FastEthernet0', sw2, 'FastEthernet0/1');
    fim();
  }

  function montarDhcp() {
    limpar();
    const sw = M.createDevice('switch', 520, 220);
    const srv = M.createDevice('server', 820, 420);
    const pc0 = M.createDevice('pc', 300, 430);
    const pc1 = M.createDevice('pc', 520, 460);
    cabo(srv, 'FastEthernet0', sw, 'FastEthernet0/8');
    cabo(pc0, 'FastEthernet0', sw, 'FastEthernet0/1');
    cabo(pc1, 'FastEthernet0', sw, 'FastEthernet0/2');
    srv.ports[0].ip = '192.168.50.1'; srv.ports[0].mask = '255.255.255.0';
    fim();
  }

  function montarVlan() {
    limpar();
    const sw = M.createDevice('switch', 520, 200);
    const nomes = ['192.168.60.11', '192.168.60.12', '192.168.60.13', '192.168.60.14'];
    nomes.forEach((ip, i) => {
      const pc = M.createDevice('pc', 200 + i * 210, 450);
      pc.ports[0].ip = ip; pc.ports[0].mask = '255.255.255.0';
      cabo(pc, 'FastEthernet0', sw, 'FastEthernet0/' + (i + 1));
    });
    fim();
  }

  function montarDefeito() {
    limpar();
    const sw = M.createDevice('switch', 520, 220);
    const pc0 = M.createDevice('pc', 320, 450);
    const pc1 = M.createDevice('pc', 720, 450);
    pc0.ports[0].ip = '192.168.70.10'; pc0.ports[0].mask = '255.255.255.0';
    pc1.ports[0].ip = '192.168.70.20'; pc1.ports[0].mask = '255.255.0.0';   // defeito 1: máscara errada
    cabo(pc0, 'FastEthernet0', sw, 'FastEthernet0/1');
    cabo(pc1, 'FastEthernet0', sw, 'FastEthernet0/2');
    M.getPort(sw, 'FastEthernet0/2').shutdown = true;                        // defeito 2: porta desligada
    fim();
  }

  /* ---- apoio ao roteiro de VLSM: valida a resposta sem revelar o cálculo ---- */
  function menorPrefixoPara(hosts) {
    let p = 30;
    while (p >= 1 && (Math.pow(2, 32 - p) - 2) < hosts) p--;
    return p;
  }
  function subredesConfiguradas() {
    const out = [];
    S.list().forEach(d => d.ports.forEach(p => {
      if (p.ip && p.mask && M.isPortUp(d, p)) {
        out.push({ dev: d, port: p, net: U.networkOf(p.ip, p.mask), prefix: U.maskToPrefix(p.mask) });
      }
    }));
    return out;
  }
  function sobrepoe(a, b) {
    const m = U.prefixToMask(Math.min(a.prefix, b.prefix));
    return U.networkOf(a.net, m) === U.networkOf(b.net, m);
  }
  function ifaceLan(nomeRoteador) {
    const r = S.byName(nomeRoteador);
    return r ? M.getPort(r, 'GigabitEthernet0/0') : null;
  }
  function ifaceWan(nomeRoteador) {
    const r = S.byName(nomeRoteador);
    return r ? M.getPort(r, 'Serial0/0/0') : null;
  }
  function blocoCerto(port, hosts) {
    return !!(port && port.ip && port.mask && U.maskToPrefix(port.mask) === menorPrefixoPara(hosts));
  }
  function dentroDoBloco(port) {
    return !!(port && port.ip && port.mask &&
      U.networkOf(port.ip, '255.255.255.0') === '192.168.1.0' &&
      U.maskToPrefix(port.mask) >= 24);
  }
  function pcDaLan(nomeRoteador) {
    const lan = ifaceLan(nomeRoteador);
    if (!lan || !lan.ip) return null;
    return pcs().find(h => h.ports[0].ip && h.ports[0].mask &&
      U.sameSubnet(h.ports[0].ip, lan.ip, lan.mask));
  }

  function montarVlsm() {
    limpar();
    const ra = M.createDevice('router', 350, 160);
    const rb = M.createDevice('router', 780, 160);
    const sa = M.createDevice('switch', 250, 330);
    const sb = M.createDevice('switch', 880, 330);
    const pa = M.createDevice('pc', 190, 480);
    const pb = M.createDevice('pc', 940, 480);
    cabo(ra, 'GigabitEthernet0/0', sa, 'GigabitEthernet0/1');
    cabo(rb, 'GigabitEthernet0/0', sb, 'GigabitEthernet0/1');
    cabo(pa, 'FastEthernet0', sa, 'FastEthernet0/1');
    cabo(pb, 'FastEthernet0', sb, 'FastEthernet0/1');
    const l = M.createLink(ra, M.getPort(ra, 'Serial0/0/0'), rb, M.getPort(rb, 'Serial0/0/0'), 'auto');
    if (l.link) M.getPort(ra, 'Serial0/0/0').clockRate = 64000;   // clock já pronto: o assunto aqui é VLSM
    fim();
  }

  /* ---------- os roteiros ---------- */
  const LABS = [
    {
      id: 'lab1',
      titulo: 'Rede local com IP fixo',
      nivel: 'Básico',
      objetivo: 'Ligar dois PCs num switch, endereçar na mesma sub-rede e provar a comunicação com ping e ARP.',
      material: ['2 PCs com Windows', '1 switch (qualquer um, não precisa ser gerenciável)', '2 cabos de rede direto'],
      montar: () => montarLan(2),
      sim: [
        'Clique em "Montar topologia base" (2 PCs ligados a um switch).',
        'Duplo clique no PC0 → aba Desktop: IP 192.168.10.10, máscara 255.255.255.0, gateway em branco.',
        'Duplo clique no PC1 → aba Desktop: IP 192.168.10.11, máscara 255.255.255.0.',
        'No Command Prompt do PC0: ipconfig',
        'Ainda no PC0: ping 192.168.10.11',
        'Depois do ping: arp -a — o MAC do PC1 aparece no cache.',
        'Duplo clique no switch → aba Tabelas: a tabela MAC aprendeu os dois endereços.'
      ],
      checks: [
        { label: 'PC com 192.168.10.10 / 255.255.255.0', test: () => ipMaskOk('192.168.10.10', '255.255.255.0') },
        { label: 'PC com 192.168.10.11 / 255.255.255.0', test: () => ipMaskOk('192.168.10.11', '255.255.255.0') },
        { label: 'Os dois PCs com enlace ativo no switch', test: () => hostsLigados(2) && enlacesAtivos(2) },
        { label: 'Ping 192.168.10.10 → 192.168.10.11 responde', ping: { de: '192.168.10.10', para: '192.168.10.11' } }
      ],
      real: {
        passos: [
          'Ligue cada PC a uma porta do switch com cabo direto e confirme o LED de link aceso.',
          'Em cada PC, abra o Prompt de Comando como administrador.',
          'Aplique o IP (comando netsh gerado no botão "Comandos reais" de cada PC, ou por ncpa.cpl).',
          'Libere o ICMP no firewall dos dois PCs.',
          'Confira com ipconfig e teste com ping do PC1 para o PC0.',
          'Rode arp -a nos dois e compare com getmac /v.'
        ],
        validar: [
          'ipconfig mostra exatamente o IP e a máscara planejados',
          'ping responde com "Resposta de 192.168.10.11: bytes=32 tempo<1ms TTL=128"',
          'arp -a lista o IP do colega com o MAC físico dele'
        ],
        armadilhas: ['Prompt sem privilégio de administrador', 'Ping não responde mesmo com IP certo', 'Wi-Fi ligado junto com o cabo', 'Dois PCs com o mesmo IP']
      }
    },

    {
      id: 'lab2',
      titulo: 'Máscara e sub-rede: por que não pinga',
      nivel: 'Básico',
      objetivo: 'Mostrar na prática que hosts em sub-redes diferentes não se comunicam sem roteador, mesmo ligados no mesmo switch.',
      material: ['2 PCs com Windows', '1 switch', '2 cabos direto'],
      montar: () => montarLan(2),
      sim: [
        'Monte a topologia base (2 PCs num switch).',
        'PC0: 192.168.10.10 / 255.255.255.0 (sem gateway).',
        'PC1: 192.168.20.10 / 255.255.255.0 (sem gateway).',
        'No PC0: ping 192.168.20.10 — falha, mesmo com cabo e link OK.',
        'Observe o log: o PC0 nem chega a enviar o pacote (não há rota) ou envia ARP que ninguém responde.',
        'Agora mude a máscara dos dois para 255.255.0.0 e repita o ping — passa a funcionar, porque agora os dois estão na mesma rede 192.168.0.0/16.'
      ],
      checks: [
        { label: 'Existe um PC em 192.168.10.10', test: () => !!devWithIp('192.168.10.10') },
        { label: 'Existe um PC em 192.168.20.10', test: () => !!devWithIp('192.168.20.10') },
        { label: 'Com /16 nos dois, o ping passa a responder', ping: { de: '192.168.10.10', para: '192.168.20.10' } }
      ],
      real: {
        passos: [
          'Configure os dois PCs com 192.168.10.10/24 e 192.168.20.10/24 e tente o ping — deve falhar.',
          'Rode arp -a nos dois: não aparece entrada para o outro host (o ARP nem sai da máquina).',
          'Troque a máscara dos dois para 255.255.0.0 e repita — funciona.',
          'Volte para /24 e confirme que quebra de novo.'
        ],
        validar: [
          'Com /24 o ping devolve "Host de destino inacessível" ou tempo esgotado',
          'Com /16 o ping responde normalmente',
          'route print mostra a rede local mudando conforme a máscara'
        ],
        armadilhas: ['Máscara diferente entre os PCs', 'Ping não responde mesmo com IP certo']
      }
    },

    {
      id: 'lab3',
      titulo: 'Duas redes com roteador (gateway e rota)',
      nivel: 'Intermediário',
      objetivo: 'Configurar as interfaces do roteador, apontar o gateway nos PCs e provar o caminho com tracert.',
      material: ['2 PCs', '1 roteador Cisco (ou 2 switches + roteador)', '2 switches', 'cabos direto', 'cabo console + PuTTY'],
      montar: montarDuasRedes,
      sim: [
        'Monte a topologia base (roteador, 2 switches e 2 PCs).',
        'Duplo clique no roteador → aba CLI e digite:',
        '   enable / configure terminal',
        '   interface g0/0 → ip address 192.168.10.1 255.255.255.0 → no shutdown → exit',
        '   interface g0/1 → ip address 192.168.20.1 255.255.255.0 → no shutdown → end',
        '   show ip interface brief (as duas devem ficar up/up)',
        'PC0: 192.168.10.10 / 255.255.255.0 / gateway 192.168.10.1',
        'PC1: 192.168.20.10 / 255.255.255.0 / gateway 192.168.20.1',
        'No PC0: ping 192.168.10.1 (gateway), depois ping 192.168.20.10 (outra rede).',
        'No PC0: tracert 192.168.20.10 — o primeiro salto é o roteador.',
        'No roteador: show ip route — as duas redes aparecem como C (conectadas).'
      ],
      checks: [
        { label: 'Roteador com 192.168.10.1 ativo (no shutdown)', test: () => portaAtivaComIp('router', '192.168.10.1') },
        { label: 'Roteador com 192.168.20.1 ativo (no shutdown)', test: () => portaAtivaComIp('router', '192.168.20.1') },
        { label: 'PC 192.168.10.10 com gateway 192.168.10.1', test: () => ipMaskOk('192.168.10.10', '255.255.255.0') && gwOk('192.168.10.10', '192.168.10.1') },
        { label: 'PC 192.168.20.10 com gateway 192.168.20.1', test: () => ipMaskOk('192.168.20.10', '255.255.255.0') && gwOk('192.168.20.10', '192.168.20.1') },
        { label: 'Ping do gateway: 192.168.10.10 → 192.168.10.1', ping: { de: '192.168.10.10', para: '192.168.10.1' } },
        { label: 'Ping entre redes: 192.168.10.10 → 192.168.20.10', ping: { de: '192.168.10.10', para: '192.168.20.10' } }
      ],
      real: {
        passos: [
          'Conecte o cabo console no roteador e abra o PuTTY em Serial COMx 9600 8N1.',
          'Aplique o script gerado no botão "Comandos reais" do roteador (é o mesmo que você digitou no simulador).',
          'Salve com copy running-config startup-config.',
          'Configure IP + máscara + gateway nos dois PCs.',
          'Teste na ordem: ping 127.0.0.1 → ping do próprio IP → ping do gateway → ping do PC da outra rede → tracert.'
        ],
        validar: [
          'show ip interface brief mostra as duas interfaces up/up',
          'show ip route lista as duas redes com o código C',
          'tracert mostra o roteador como primeiro salto e o destino como segundo'
        ],
        armadilhas: ['Esquecer de salvar no equipamento Cisco', 'LED de link apagado', 'Ping não responde mesmo com IP certo', 'Prompt sem privilégio de administrador']
      },
      dica: 'Interface de roteador Cisco nasce desligada: sem "no shutdown" ela fica administratively down, no simulador e no equipamento real.'
    },

    {
      id: 'lab4',
      titulo: 'DHCP: endereço automático',
      nivel: 'Intermediário',
      objetivo: 'Entregar IP, máscara, gateway e DNS automaticamente e acompanhar as quatro mensagens do DHCP.',
      material: ['2 PCs', '1 switch', '1 servidor DHCP (roteador da bancada ou servidor da escola)'],
      montar: montarDhcp,
      sim: [
        'Monte a topologia base (servidor + 2 PCs no switch). O servidor já vem com 192.168.50.1/24.',
        'Duplo clique no servidor → aba Serviços → ligue o DHCP:',
        '   IP inicial 192.168.50.100, máscara 255.255.255.0, gateway 192.168.50.1, DNS 192.168.50.1',
        'Duplo clique no PC0 → aba Config → marque "DHCP".',
        'No Command Prompt do PC0: ipconfig /renew e depois ipconfig /all.',
        'Repita no PC1 e confira que cada um recebeu um endereço diferente.',
        'Volte ao servidor → aba Serviços: a lista de concessões mostra MAC × IP entregue.',
        'Acompanhe no log as mensagens DISCOVER, OFFER, REQUEST e ACK.'
      ],
      checks: [
        { label: 'Servidor com serviço DHCP ligado', test: () => S.list().some(d => d.services && d.services.dhcp && d.services.dhcp.on) },
        { label: 'Pelo menos 1 PC em modo DHCP', test: () => pcs().some(h => h.dhcpMode) },
        { label: 'Pelo menos 1 PC recebeu endereço da faixa 192.168.50.x', test: () => pcs().some(h => h.dhcpMode && /^192\.168\.50\./.test(h.ports[0].ip || '')) },
        { label: 'PC com IP automático alcança o servidor 192.168.50.1', pingAuto: { para: '192.168.50.1' } }
      ],
      real: {
        passos: [
          'Ligue os PCs no switch junto com o roteador/servidor que fornece DHCP.',
          'Coloque os PCs em automático: netsh interface ipv4 set address name="Ethernet" source=dhcp',
          'Force a renovação: ipconfig /release seguido de ipconfig /renew.',
          'Verifique tudo com ipconfig /all (endereço, servidor DHCP, concessão obtida e expira em).',
          'Se aparecer 169.254.x.x, o PC não achou o servidor: confira cabo, porta e se o serviço está ligado.'
        ],
        validar: [
          'ipconfig /all mostra "DHCP Habilitado: Sim" e o IP do servidor DHCP',
          'Cada PC recebeu um endereço diferente da mesma faixa',
          'O gateway e o DNS vieram preenchidos automaticamente'
        ],
        armadilhas: ['PC pegou 169.254.x.x', 'Wi-Fi ligado junto com o cabo', 'Prompt sem privilégio de administrador']
      }
    },

    {
      id: 'lab5',
      titulo: 'VLANs separando dois grupos',
      nivel: 'Intermediário',
      objetivo: 'Criar duas VLANs num switch gerenciável e provar que hosts de VLANs diferentes não se enxergam, mesmo com IP da mesma sub-rede.',
      material: ['4 PCs (ou 2)', '1 switch GERENCIÁVEL (ex.: Catalyst 2960)', 'cabo console + PuTTY', 'cabos direto'],
      montar: montarVlan,
      sim: [
        'Monte a topologia base (4 PCs já endereçados em 192.168.60.11 a .14 /24).',
        'Confirme primeiro que todos se pingam (tudo na VLAN 1).',
        'Duplo clique no switch → aba CLI:',
        '   enable / configure terminal',
        '   vlan 10 → name VENDAS → exit',
        '   vlan 20 → name TECNICO → exit',
        '   interface f0/1 → switchport mode access → switchport access vlan 10 → exit',
        '   interface f0/2 → switchport mode access → switchport access vlan 10 → exit',
        '   interface f0/3 → switchport mode access → switchport access vlan 20 → exit',
        '   interface f0/4 → switchport mode access → switchport access vlan 20 → end',
        '   show vlan brief',
        'Teste de novo: PC da f0/1 pinga o da f0/2 (mesma VLAN) e NÃO pinga o da f0/3.'
      ],
      checks: [
        { label: 'VLAN 10 criada no switch', test: () => byType('switch').some(s => s.vlans[10]) },
        { label: 'VLAN 20 criada no switch', test: () => byType('switch').some(s => s.vlans[20]) },
        { label: 'Fa0/1 e Fa0/2 em acesso na VLAN 10', test: () => vlanDePorta(null, 'FastEthernet0/1', 10) && vlanDePorta(null, 'FastEthernet0/2', 10) },
        { label: 'Fa0/3 e Fa0/4 em acesso na VLAN 20', test: () => vlanDePorta(null, 'FastEthernet0/3', 20) && vlanDePorta(null, 'FastEthernet0/4', 20) },
        { label: 'Mesma VLAN se comunica: .11 → .12', ping: { de: '192.168.60.11', para: '192.168.60.12' } },
        { label: 'VLANs diferentes NÃO se comunicam: .11 → .13', ping: { de: '192.168.60.11', para: '192.168.60.13', esperado: false } }
      ],
      real: {
        passos: [
          'Confirme que o switch é gerenciável (tem porta console). Switch simples não faz VLAN.',
          'Console + PuTTY 9600 8N1, entre em enable.',
          'Aplique o script do botão "Comandos reais" do switch.',
          'Anote em qual porta física está cada PC — o número da porta é o que separa os grupos.',
          'Teste ping dentro do grupo e entre grupos.',
          'Salve com copy running-config startup-config.'
        ],
        validar: [
          'show vlan brief lista VLAN 10 e 20 com as portas certas',
          'Ping dentro da mesma VLAN responde',
          'Ping entre VLANs diferentes falha, mesmo com IPs da mesma faixa',
          'show mac address-table mostra os MACs separados por VLAN'
        ],
        armadilhas: ['Switch não gerenciável', 'Esquecer de salvar no equipamento Cisco', 'LED de link apagado']
      },
      dica: 'Se depois disso os grupos precisarem conversar, é preciso um roteador (router-on-a-stick) ou switch de camada 3 — isso já é o próximo assunto.'
    },

    {
      id: 'lab6',
      titulo: 'Diagnóstico camada por camada',
      nivel: 'Prática',
      objetivo: 'Achar e corrigir defeitos usando a mesma sequência de testes que se usa na bancada.',
      material: ['2 PCs', '1 switch', 'cabos'],
      montar: montarDefeito,
      sim: [
        'Clique em "Montar topologia base": ela vem com dois defeitos propositais.',
        'Sequência de diagnóstico (de baixo para cima):',
        '   1) Físico: o cabo do PC1 está com o enlace vermelho? Veja a barra de status ao clicar no cabo.',
        '   2) No switch → aba Config, encontre a porta desligada e reative (ou no CLI: interface f0/2 → no shutdown).',
        '   3) Endereçamento: rode ipconfig nos dois PCs e compare máscara.',
        '   4) Corrija a máscara do PC1 para 255.255.255.0.',
        '   5) Teste: ping 127.0.0.1 → ping do próprio IP → ping do outro PC.',
        'Só depois de tudo verde, confira arp -a e a tabela MAC do switch.'
      ],
      checks: [
        { label: 'Nenhum enlace em estado down', test: () => S.linkList().length > 0 && S.linkList().every(l => M.linkUp(l)) },
        { label: 'Os dois PCs com máscara 255.255.255.0', test: () => hosts().filter(h => h.ports[0].mask === '255.255.255.0').length >= 2 },
        { label: 'Ping 192.168.70.10 → 192.168.70.20 responde', ping: { de: '192.168.70.10', para: '192.168.70.20' } }
      ],
      real: {
        passos: [
          'Mesma ordem na bancada: LED de link → cabo → porta do switch → IP/máscara → gateway → DNS.',
          'ping 127.0.0.1 testa a pilha TCP/IP do próprio Windows.',
          'ping do próprio IP testa a placa de rede.',
          'ping do gateway testa a rede local.',
          'ping de um IP externo (8.8.8.8) testa a saída; ping de um nome (google.com) testa o DNS.',
          'Se o IP funciona e o nome não, o problema é DNS.'
        ],
        validar: [
          'Consegue dizer em qual etapa a comunicação quebrou antes de mexer em qualquer coisa',
          'Cada correção é testada isoladamente antes da próxima'
        ],
        armadilhas: ['LED de link apagado', 'Máscara diferente entre os PCs', 'Ping não responde mesmo com IP certo', 'Antivírus com firewall próprio']
      }
    },

    {
      id: 'lab7',
      titulo: 'VLSM: dividir um bloco em sub-redes',
      nivel: 'Avançado',
      objetivo: 'Dividir 192.168.1.0/24 em sub-redes de tamanhos diferentes, aplicar nos equipamentos e provar a comunicação fim a fim. O cálculo é seu — o simulador só aceita ou recusa, como o equipamento real.',
      material: ['2 PCs', '2 roteadores Cisco', '2 switches', 'cabo serial entre os roteadores', 'cabo console + PuTTY'],
      montar: montarVlsm,
      sim: [
        'ENUNCIADO — bloco disponível: 192.168.1.0/24. Divida em três sub-redes:',
        '   • LAN A (atrás do Router0): precisa de 50 hosts',
        '   • LAN B (atrás do Router1): precisa de 20 hosts',
        '   • Enlace serial entre os dois roteadores: 2 hosts',
        'Regra: cada sub-rede deve usar o MENOR bloco que atenda à necessidade, sem sobrepor as outras.',
        'Calcule no caderno: máscara, endereço de rede, faixa de hosts e broadcast de cada sub-rede.',
        'Só depois aplique aqui: interfaces dos roteadores pelo CLI, PCs pela aba Desktop.',
        'Configure a rota estática nos dois roteadores para a LAN do outro lado.',
        'Teste com ping do PC da LAN A para o PC da LAN B e depois tracert.',
        'Se o simulador recusar um endereço, ele é endereço de rede ou de broadcast — refaça a conta.'
      ],
      checks: [
        { label: 'LAN A (Router0 g0/0) usa o menor bloco que comporta 50 hosts', test: () => blocoCerto(ifaceLan('Router0'), 50) },
        { label: 'LAN B (Router1 g0/0) usa o menor bloco que comporta 20 hosts', test: () => blocoCerto(ifaceLan('Router1'), 20) },
        { label: 'Enlace serial usa o menor bloco possível (2 hosts)', test: () => blocoCerto(ifaceWan('Router0'), 2) && blocoCerto(ifaceWan('Router1'), 2) },
        {
          label: 'Todas as sub-redes estão dentro de 192.168.1.0/24',
          test: () => {
            const ps = [ifaceLan('Router0'), ifaceLan('Router1'), ifaceWan('Router0')];
            return ps.every(p => p && p.ip) && ps.every(dentroDoBloco);
          }
        },
        {
          label: 'Nenhuma sub-rede se sobrepõe a outra',
          test: () => {
            const subs = subredesConfiguradas().filter(x => x.dev.type === 'router');
            const unicas = [];
            subs.forEach(x => { if (!unicas.some(y => y.net === x.net && y.prefix === x.prefix)) unicas.push(x); });
            for (let i = 0; i < unicas.length; i++)
              for (let j = i + 1; j < unicas.length; j++)
                if (sobrepoe(unicas[i], unicas[j])) return false;
            return unicas.length >= 3;
          }
        },
        {
          label: 'PCs com endereço de host válido e gateway na própria sub-rede',
          test: () => {
            const a = pcDaLan('Router0'), b = pcDaLan('Router1');
            if (!a || !b) return false;
            return [[a, ifaceLan('Router0')], [b, ifaceLan('Router1')]].every(par => {
              const pc = par[0], lan = par[1], p = pc.ports[0];
              return !U.hostAddrProblem(p.ip, p.mask) && p.mask === lan.mask &&
                pc.gateway === lan.ip && U.sameSubnet(p.ip, lan.ip, p.mask);
            });
          }
        },
        {
          label: 'Ping do PC da LAN A para o PC da LAN B responde',
          pingDin: () => {
            const a = pcDaLan('Router0'), b = pcDaLan('Router1');
            return (a && b) ? { de: a.ports[0].ip, para: b.ports[0].ip } : null;
          }
        }
      ],
      real: {
        passos: [
          'Leve a tabela que você calculou no caderno: rede, máscara, faixa de hosts, broadcast e gateway de cada sub-rede.',
          'Console nos dois roteadores: configure g0/0, a serial (clock rate no lado DCE) e a rota estática.',
          'Configure os PCs com um endereço de host válido da sua sub-rede e o gateway correspondente.',
          'Teste na ordem: gateway local → interface serial do outro roteador → PC do outro lado → tracert.'
        ],
        validar: [
          'show ip route mostra as três sub-redes com os prefixos que você calculou',
          'ping do PC da LAN A para o PC da LAN B responde',
          'tracert mostra dois saltos antes do destino'
        ],
        armadilhas: ['Máscara diferente entre os PCs', 'Esquecer de salvar no equipamento Cisco', 'Dois PCs com o mesmo IP', 'Ping não responde mesmo com IP certo']
      },
      dica: 'Endereço recusado é informação, não erro do simulador: significa que a conta precisa ser refeita.'
    }
  ];

  /* ======================================================================
     JANELA DO LABORATÓRIO
     ====================================================================== */
  let win = null, atual = LABS[0], timer = null;
  const pingResults = {};      // "labId:idx" -> true/false/'testando'

  function open() {
    if (win) { win.root.style.zIndex = 999; return; }
    win = PT.ui.makeWindow('Laboratório — do simulador para a bancada', 'lab');
    win.root.addEventListener('remove', () => { });
    const origClose = win.close;
    win.close = () => { clearInterval(timer); timer = null; win = null; origClose(); };
    win.root.querySelector('.x').onclick = win.close;
    paint();
    timer = setInterval(() => { if (win) pintarChecks(); }, 1200);
  }

  function paint() {
    if (!win) return;
    win.body.innerHTML = '<div class="labWrap"><div class="labList"></div><div class="labDetail"></div></div>';
    const list = win.body.querySelector('.labList');
    const det = win.body.querySelector('.labDetail');

    LABS.forEach(l => {
      const d = PT.ui.elDiv('labItem' + (l === atual ? ' sel' : ''),
        `<b>${U.esc(l.titulo)}</b><span class="muted">${U.esc(l.nivel)}</span>`);
      d.onclick = () => { atual = l; paint(); };
      list.appendChild(d);
    });
    const arm = PT.ui.elDiv('labItem armItem', '<b>⚠ Armadilhas da bancada</b><span class="muted">leia antes da aula prática</span>');
    arm.onclick = () => openArmadilhas();
    list.appendChild(arm);

    const l = atual;
    det.innerHTML = `
      <h2>${U.esc(l.titulo)} <span class="muted">— ${U.esc(l.nivel)}</span></h2>
      <div class="hintbox"><b>Objetivo:</b> ${U.esc(l.objetivo)}</div>
      <fieldset><legend>Material no laboratório real</legend><ul class="tight">${l.material.map(m => `<li>${U.esc(m)}</li>`).join('')}</ul></fieldset>
      <fieldset><legend>Passo a passo no simulador</legend>
        <ol class="tight">${l.sim.map(s => `<li>${U.esc(s)}</li>`).join('')}</ol>
        ${l.dica ? `<div class="hintbox">💡 ${U.esc(l.dica)}</div>` : ''}
      </fieldset>
      <fieldset><legend>Verificação automática</legend><div class="checks"></div>
        <div class="formRow" style="margin-top:8px">
          <button class="btnPing">Testar conectividade</button>
          <span class="muted">Os itens de configuração são conferidos sozinhos; os de ping rodam quando você clica.</span>
        </div>
      </fieldset>
      <fieldset><legend>Depois: como fazer isso no laboratório real</legend>
        <ol class="tight">${l.real.passos.map(s => `<li>${U.esc(s)}</li>`).join('')}</ol>
        <b class="muted">Como saber que deu certo:</b>
        <ul class="tight">${l.real.validar.map(s => `<li>${U.esc(s)}</li>`).join('')}</ul>
        <b class="muted">Cuidado com:</b>
        <ul class="tight">${l.real.armadilhas.map(s => `<li>${U.esc(s)}</li>`).join('')}</ul>
      </fieldset>
      <div class="formRow">
        <button class="btnMontar">Montar topologia base</button>
        <button class="btnCmds">Comandos reais dos dispositivos</button>
        <button class="btnArm">Ver armadilhas</button>
      </div>`;

    det.querySelector('.btnMontar').onclick = () => {
      if (!confirm('Isto apaga a topologia atual e monta a do roteiro. Continuar?')) return;
      l.montar();
      Object.keys(pingResults).forEach(k => delete pingResults[k]);
      PT.ui.toast('Topologia do roteiro montada');
      pintarChecks();
    };
    det.querySelector('.btnCmds').onclick = () => openSeletorDispositivo();
    det.querySelector('.btnArm').onclick = () => openArmadilhas();
    det.querySelector('.btnPing').onclick = e => rodarPings(e.target);
    pintarChecks();
  }

  function pintarChecks() {
    if (!win) return;
    const box = win.body.querySelector('.checks');
    if (!box) return;
    box.innerHTML = '';
    atual.checks.forEach((c, i) => {
      let estado;
      if (c.test) estado = c.test() ? 'ok' : 'no';
      else {
        const r = pingResults[atual.id + ':' + i];
        estado = r === undefined ? 'idle' : (r === 'testando' ? 'run' : (r ? 'ok' : 'no'));
      }
      const icon = { ok: '✔', no: '✖', idle: '○', run: '…' }[estado];
      box.appendChild(PT.ui.elDiv('chk chk-' + estado, `<span class="ic">${icon}</span> ${U.esc(c.label)}`));
    });
  }

  function rodarPings(btn) {
    const l = atual;
    const alvos = l.checks.map((c, i) => ({ c, i })).filter(x => x.c.ping || x.c.pingAuto || x.c.pingDin);
    if (!alvos.length) { PT.ui.toast('Este roteiro não tem teste de ping'); return; }
    btn.disabled = true; btn.textContent = 'Testando...';
    let n = 0;
    const next = () => {
      if (n >= alvos.length) { btn.disabled = false; btn.textContent = 'Testar conectividade'; pintarChecks(); return; }
      const { c, i } = alvos[n++];
      const key = l.id + ':' + i;
      let origem, destino;
      if (c.ping) { origem = devWithIp(c.ping.de); destino = c.ping.para; }
      else if (c.pingDin) {
        const par = c.pingDin();
        if (par) { origem = devWithIp(par.de); destino = par.para; }
      }
      else { origem = pcs().find(h => h.dhcpMode && h.ports[0].ip) || pcs()[0]; destino = c.pingAuto.para; }
      if (!origem || !destino) { pingResults[key] = false; pintarChecks(); return next(); }
      pingResults[key] = 'testando'; pintarChecks();
      const esperado = c.ping && c.ping.esperado === false ? false : true;
      PT.engine.ping(origem, destino, { count: 2, interval: 200 }, {
        onLine: () => { },
        onDone: st => {
          const respondeu = !!(st && st.recv > 0);
          pingResults[key] = (respondeu === esperado);
          pintarChecks();
          next();
        }
      });
    };
    next();
  }

  /* ---------------------------------------------------- armadilhas */
  function openArmadilhas() {
    const w = PT.ui.makeWindow('Armadilhas da bancada — leia antes da aula prática', 'lab');
    w.body.innerHTML =
      '<div class="hintbox">Estes são os motivos mais comuns de "no simulador funcionou e no laboratório não".</div>' +
      ARMADILHAS.map(a => `<fieldset><legend>${U.esc(a.t)}</legend><div>${U.esc(a.d)}</div></fieldset>`).join('');
  }

  /* ---------------------------------------------------- comandos reais */
  function openSeletorDispositivo() {
    const w = PT.ui.makeWindow('Comandos reais — escolha o dispositivo', '');
    const lista = S.list();
    if (!lista.length) { w.body.innerHTML = '<div class="muted">Nenhum dispositivo na topologia.</div>'; return; }
    w.body.innerHTML = '<div class="hintbox">Gera os comandos equivalentes ao que está configurado no simulador.</div>';
    lista.forEach(d => {
      const b = PT.ui.elBtn(`${d.name} — ${d.model}`, () => { w.close(); openCommands(d); });
      b.style.display = 'block'; b.style.margin = '4px 0'; b.style.width = '100%'; b.style.textAlign = 'left';
      w.body.appendChild(b);
    });
  }

  function openCommands(dev) {
    const w = PT.ui.makeWindow(`Comandos reais — ${dev.name}`, 'lab');
    const blocos = deviceCommands(dev);
    const html = blocos.map((b, i) => `
      <fieldset>
        <legend>${U.esc(b.titulo)}</legend>
        ${b.nota ? `<div class="muted" style="margin-bottom:6px">${U.esc(b.nota)}</div>` : ''}
        <pre class="cmd" data-i="${i}">${U.esc(b.linhas.join('\n'))}</pre>
        <button class="copy" data-i="${i}">Copiar</button>
      </fieldset>`).join('');
    w.body.innerHTML =
      `<div class="hintbox">${dev.klass === 'host'
        ? 'Digite estes comandos no PC real do laboratório. O Prompt de Comando precisa estar aberto como <b>administrador</b>.'
        : 'Cole estas linhas no console do equipamento real (PuTTY, Serial 9600 8N1). Uma linha por vez.'}</div>` + html;

    w.body.querySelectorAll('.copy').forEach(btn => {
      btn.onclick = () => {
        const txt = blocos[+btn.dataset.i].linhas.join('\n');
        if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => PT.ui.toast('Copiado'), () => fallback(txt));
        else fallback(txt);
      };
    });
    function fallback(txt) {
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); PT.ui.toast('Copiado'); } catch (e) { PT.ui.toast('Selecione e copie manualmente', true); }
      ta.remove();
    }
  }

  PT.lab = { open, openCommands, openArmadilhas, LABS, ARMADILHAS, iosScript, deviceCommands, onRefresh: pintarChecks };
})(window);
