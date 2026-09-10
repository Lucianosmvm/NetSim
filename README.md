# NetSim — simulador de redes no navegador (estilo Cisco Packet Tracer)

HTML + CSS + JavaScript puro, sem dependências, sem build. Abra `index.html` no navegador.

## O que dá para fazer

| Packet Tracer | NetSim |
|---|---|
| Arrastar dispositivos para a área lógica | Paleta → clique no dispositivo → clique na tela |
| Roteador, switch, hub, PC, notebook, servidor | idem (ISR 1941, Catalyst 2960, PT-Hub, PC/Laptop/Server-PT) |
| Cabos direto / crossover / serial, com validação | idem + modo automático; cabo errado deixa o enlace **down** |
| Aba Config (formulários) | idem — nome, IP, máscara, gateway, DNS, VLAN, rotas estáticas, clock rate |
| Aba Desktop → IP Configuration / Command Prompt | idem — `ipconfig`, `ping`, `tracert`, `arp`, `nslookup` |
| Aba CLI com IOS | idem — `enable`, `configure terminal`, `interface`, `ip address`, `no shutdown`, `show ...`, com abreviações |
| Serviços do servidor (DHCP, DNS) | idem (DHCP 4 vias: discover/offer/request/ack; DNS com registros A) |
| Simulação de pacotes (PDU) | quadros animados no cabo + log explicando cada decisão |

Protocolos implementados de verdade: **ARP**, **ICMP** (echo, time exceeded, destination unreachable),
**comutação L2 com aprendizado de MAC, flooding e VLANs (access/trunk)**, **roteamento IP com longest
prefix match, rotas conectadas e estáticas, decremento de TTL**, **DHCP** e **DNS**.

## Como usar

1. **Montar** — clique num dispositivo da paleta e depois na tela. Ferramenta **Cabo**: clique no
   primeiro dispositivo → escolha a porta → clique no segundo → escolha a porta.
2. **Configurar** — duplo clique no dispositivo.
   * PC / notebook / servidor: abas **Config** e **Desktop** (IP estático ou DHCP).
   * Roteador / switch: aba **Config** (formulários), **CLI** (IOS) e **Tabelas** (MAC, roteamento, ARP).
3. **Testar** — ferramenta **📨 Pacote** (tecla `P`): clique na origem e depois no destino para disparar
   um pacote de teste (ICMP echo); o resultado e o motivo da falha aparecem na **Lista de PDUs**, no canto
   inferior direito. Ou, no Desktop do PC: `ping 192.168.2.10`, `tracert`, `arp -a`, `ipconfig /all`,
   `ipconfig /renew`. Acompanhe os quadros animados e o log no rodapé.

Os quadros atravessam os cabos animados como envelopes, com rastro e o nome do protocolo, e o cabo em uso
fica aceso. Cada cabo leva ~380 ms de simulação; o controle **Velocidade** (0,25x a 4x) deixa acompanhar
quadro a quadro ou acelerar.

Cores dos pacotes: amarelo = ARP · verde = ICMP · rosa = DHCP · azul = DNS · vermelho = erro ICMP.

## Do simulador para a bancada (botão 🎓 Laboratório)

O objetivo é o aluno aprender aqui e reproduzir no laboratório real. Três recursos:

1. **Roteiros guiados com verificação automática** — 6 práticas, cada uma com objetivo, material real,
   passo a passo no simulador, checklist que fica verde sozinho conforme o aluno acerta a configuração
   (inclusive testes de ping, e testes que devem *falhar*, como VLANs isoladas) e a seção
   **"Depois: como fazer isso no laboratório real"**:

   | Roteiro | Assunto |
   |---|---|
   | 1. Rede local com IP fixo | endereçamento, ping, ARP, tabela MAC |
   | 2. Máscara e sub-rede | por que hosts em sub-redes diferentes não se falam |
   | 3. Duas redes com roteador | interfaces, `no shutdown`, gateway, tracert |
   | 4. DHCP | DISCOVER/OFFER/REQUEST/ACK, concessões, `ipconfig /renew` |
   | 5. VLANs | separar grupos num switch gerenciável |
   | 6. Diagnóstico camada por camada | achar defeitos na ordem certa |
   | 7. VLSM | dividir um bloco em sub-redes de tamanhos diferentes |

   **Sem calculadora, de propósito.** O roteiro de VLSM dá os requisitos (50 hosts, 20 hosts, enlace de 2 hosts
   dentro de 192.168.1.0/24), o aluno calcula no caderno e aplica; a verificação só diz **certo ou errado**,
   nunca mostra a resposta. O simulador recusa endereço de rede e endereço de broadcast como IP de host —
   igual ao Windows e ao IOS — e a mensagem manda refazer o cálculo, sem entregar a faixa.

   **Conflito de endereço IP** é simulado de verdade: ao aplicar um IP, o equipamento manda um ARP gratuito;
   se outro já usa aquele endereço, quem chegou depois **perde o endereço** (fica mudo, `ipconfig` mostra
   "Duplicado", `ping` responde "PING: transmit failed. General failure."), com aviso na tela e marca ⚠ no
   ícone — exatamente o comportamento do Windows na bancada.

2. **🔧 Comandos reais** (botão dentro da janela de cada equipamento) — converte o que está configurado
   no simulador para o que o aluno digita na máquina real:
   * PC: `netsh interface ipv4 set address ...`, o caminho equivalente por `ncpa.cpl`, o `nmcli` do Linux,
     a regra de firewall que libera o ping e a bateria de testes (`ipconfig /all`, `ping`, `arp -a`, `tracert`, `getmac`).
   * Switch/roteador: como conectar o cabo console (PuTTY, 9600 8N1) e o **script IOS pronto para colar**,
     terminando em `copy running-config startup-config`, mais os comandos para zerar o equipamento da turma anterior.

3. **⚠ Armadilhas da bancada** — os motivos clássicos de "no simulador funcionou e no laboratório não":
   prompt sem administrador, firewall do Windows descartando ICMP, Wi-Fi ligado junto com o cabo,
   APIPA 169.254.x.x, máscaras diferentes, IP duplicado, switch não gerenciável, Auto-MDIX,
   esquecer de salvar a configuração no Cisco.

### O que transfere 1:1 para o equipamento real

Todos os comandos IOS do simulador, os comandos de diagnóstico do Windows (`ping`, `tracert`, `arp -a`,
`nslookup`, `ipconfig`), e os conceitos (sub-rede, ARP, tabela MAC, VLAN, rota estática, TTL, DHCP, DNS).
**Atenção:** no Windows real o `ipconfig` só mostra informação — quem configura o IP é o `netsh` ou a
janela do adaptador (`ncpa.cpl`); é justamente essa a tradução que o botão "Comandos reais" entrega.

## Regras de cabeamento (iguais às reais)

* **Direto (straight-through)**: equipamentos de grupos diferentes — PC↔Switch, Roteador↔Switch.
* **Crossover**: equipamentos iguais — PC↔PC, PC↔Roteador, Switch↔Switch, Switch↔Hub.
* **Serial**: só entre portas seriais; o lado **DCE** precisa de `clock rate` para o enlace subir.
* Em **Automático** o cabo correto é escolhido sozinho.

## Comandos IOS suportados

```
enable | disable | configure terminal | exit | end | ?
hostname NOME
interface g0/0 | f0/1 | s0/0/0 | vlan 1        (abreviações aceitas)
  ip address 192.168.1.1 255.255.255.0 | no ip address
  no shutdown | shutdown | description TEXTO
  clock rate 64000 | bandwidth N
  switchport mode access|trunk | switchport access vlan 10 | switchport trunk native vlan N
vlan 10 → name VENDAS
ip route 192.168.3.0 255.255.255.0 10.0.0.2 | no ip route ...
ip default-gateway 192.168.1.1                (switch)
enable secret SENHA
show ip interface brief | show ip route | show running-config | show interfaces [if]
show mac address-table | show vlan brief | show ip arp | show version
ping DESTINO | traceroute DESTINO | clear mac address-table | copy running-config startup-config
```

## Comandos do PC (Desktop → Command Prompt)

```
ipconfig [/all] [/renew] [/release]
ping <ip|nome> [-n contagem] [-l tamanho]
tracert <ip|nome>
arp -a | arp -d
nslookup <nome>
hostname | cls | help
```

## Atalhos

`V` selecionar · `C` cabo · `D` excluir · `Del` apagar seleção · `Esc` cancelar ·
roda do mouse = zoom · `Shift`+arrastar = mover a tela · duplo clique = configurar.

## Arquivos

```
index.html        layout
css/style.css     tema escuro
js/util.js        endereçamento IPv4/MAC, helpers
js/model.js       dispositivos, portas, cabos, serialização
js/engine.js      motor: quadros, ARP, ICMP, switching, roteamento, DHCP, DNS
js/cli.js         shells do Windows e do IOS
js/ui.js          canvas SVG, paleta, janelas, terminais, log
js/lab.js         roteiros guiados, verificação automática, comandos reais, armadilhas
js/main.js        laço principal (relógio + desenho)
```

A topologia é salva automaticamente no `localStorage`; **Salvar** / **Abrir** exportam e importam JSON.

## Limitações conhecidas

Não há STP, roteamento dinâmico (RIP/OSPF/EIGRP), NAT, ACL, sub-interfaces (router-on-a-stick),
IPv6, wireless, TCP/HTTP nem o modo *Simulation* com filtro de PDU do Packet Tracer.
Os tempos em ms vêm do relógio da simulação (≈180 ms por cabo, para dar tempo de ver a animação).
