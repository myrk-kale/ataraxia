# Auditoria 001: relatório de correção (2026-11-12)

Os 29 achados de `audit-001-2026-11-12.md` foram tratados. Quatro decisões foram respondidas pelo dono antes da correção: idioma (inglês), abertura (uma vez por instalação, qualquer tecla pula), provedor Fake (só em desenvolvimento), marca dos agentes (inicial em quadrado de cor).

Direção registrada em `DESIGN.md` (dials ENERGY 1 / RHYTHM 1 / MOTION 1).

## Evidência

- `pnpm typecheck`: sem erros. `pnpm test`: 17 arquivos, 121 testes passando (eram 105; 16 novos em `app/product.test.tsx` e `flow/layout.test.ts`). `pnpm build`: ok. `cargo check` em `src-tauri`: ok depois da mudança de `tauri.conf.json` (só o aviso antigo de `codex.rs`).
- **Click-through em Chrome real** (Playwright em `scratchpad`, fora do repositório): 32 de 32 passos, console sem erro nem aviso, tema claro e escuro, janela de 1280x800 e de 960x640. Rodou três vezes: contra o servidor de desenvolvimento, e contra um build servido com a CSP do app (inclui Monaco, React Flow e HeroUI). O build de produção sem Tauri também foi aberto: mostra "The workspace did not open" com "Try again", sem violação de CSP.
- Contraste medido com `contrast-check.py` nos tokens finais (claro e escuro): todo texto passa 4,5:1 (mínimo 4,68), todo controle e borda passa 3:1 (mínimo 3,12).
- O click-through achou dois defeitos que nenhum teste de unidade pegava, ambos corrigidos: (a) o tooltip do HeroUI envolvia cada botão num `div role="button" tabindex="0"`, duplicando o controle e o nome acessível; (b) o campo do BTW ficava `disabled` ao enviar a pergunta, o foco ia para o `body` e `Esc` deixava de fechar o diálogo.

## Status por item

| # | Status | O que mudou |
|---|--------|-------------|
| 1 | feito | `--cg-muted` 3,44:1 → 5,17:1 no painel (4,68:1 no pior fundo); `--cg-muted-strong` também escurecido; placeholders sem `/70` |
| 2 | feito | `--cg-amber-text`, vermelho (5,98:1), verde, acento, `add-fg` e `del-fg` com tokens de texto que passam 4,5:1 em todo fundo |
| 3 | feito | `--cg-control` (3,12:1 a 3,44:1 claro, 3,3:1 escuro) em campos, arestas e nós do Flow, EdgeNav, grip do terminal, borda do terminal |
| 4 | feito | os dois travessões saíram; nenhum "—" no texto da interface |
| 5 | feito | `input/textarea/select:focus-visible` global; `.cg-field` leva o anel para o compositor. Medido: anel `solid 2px` no compositor |
| 6 | feito | grip é `role="separator"` focável, setas mudam a altura, Home/End vão aos limites. Medido: 245 → 269 |
| 7 | feito | estados de carregamento e de falha (com causa e "Try again") em Decisions, Flow, Artifacts, lista do Code, árvore de arquivos e abertura do workspace |
| 8 | feito | botões de Artifacts (com contagem de falhas) e de atalhos no cabeçalho, com dicas; dicas de Space em Code, Decisions e Flow. O BTW continua só por atalho, por decisão da spec |
| 9 | feito | prioridade, estado de revisão, status da sessão e subagentes têm palavra ou forma além da cor; Approve/Reject viram "Approved"/"Rejected"; o porquê de cada unidade aparece na linha ativa e em tooltip que abre com foco |
| 10 | feito | provedor demo some em release e só aparece em desenvolvimento ou num chat que já o usa; sem agente instalado a tela diz o que instalar. Coberto por testes de `visibleProviders`/`pickProvider` |
| 11 | feito | cabeçalho do arquivo em duas linhas com chips de estado. Medido a 960x640: sem overflow horizontal |
| 12 | feito | click-through descrito acima |
| 13 | feito | `ProviderMark`: inicial em quadrado com tint próprio (tokens claro e escuro); o ✳ saiu das três telas |
| 14 | feito | piso de 12px (tokens `nano` e `micro` removidos), rótulos em caixa baixa com peso, razão da fonte em `DESIGN.md` |
| 15 | feito | blur só no fundo do diálogo de permissão; EdgeNav e barra do Flow com fundo sólido |
| 16 | feito | `--shadow-cg-pop` e `--shadow-cg-lift` com variante escura; nenhuma sombra escrita no JSX |
| 17 | feito | `cg-page-in` e `cg-pulse` removidos; sobram spinners e os três pontos de "digitando" como indicadores de trabalho |
| 18 | feito | `ataraxia.introSeen`; qualquer tecla ou clique pula; dica "Press any key to skip". Medido: toca na primeira abertura, some com Shift, não volta no reload |
| 19 | feito | três raios (`sm`, `md`, `lg`), zero espaçamentos arbitrários em padding, margem e gap, `Button` com `size` e sem `!` |
| 20 | feito | modificado e renomeado sem cor; assinatura alterada vira chip neutro; nós do Flow só destacam a entrada; "stale" é âmbar |
| 21 | feito | `Chip` para "Judged by Claude Code", "Ranked from code facts", "Read-only", "Edited since this checkpoint" |
| 22 | feito | "Provider" em todo lugar, BTW explicado no próprio diálogo, status em palavras, sugestões do chat usam repositório e branch |
| 23 | feito | `theme.ts` protegido, `ErrorBoundary` por espaço e na tela de Chat, JSON do MCP sem `parse` no render |
| 24 | feito | `public/theme-init.js` aplica o tema antes do React. Medido: sistema claro e sistema escuro começam no tema certo |
| 25 | feito | efeito vazio, `blurb` em português e o `replace` sem efeito saíram |
| 26 | feito | `favicon.svg` e os ícones do bundle vêm do A da marca; `tauri.svg` removido |
| 27 | feito, ver nota | CSP restritiva em `tauri.conf.json` |
| 28 | feito | `useSessionActivity`: "Agent needs approval" e "Agent working" no cabeçalho quando você está fora do Chat. Medido com `?state=permission` |
| 29 | decidido | inglês: `lang="en"` mantido, `blurb` removido |

## Delivery Gate

Hard Gate: R-02 PASS (grep sem "—" em `src`, `DESIGN.md`, `README.md`); R-03 PASS a 960px; R-17/R-18/R-36/R-38 PASS (nenhum número, depoimento ou reivindicação inventada; o provedor demo saiu do release); R-23 PASS com ressalva abaixo (o ícone vem da marca existente); R-24/R-26 PASS (os controles percorridos nos 32 passos fazem o que dizem; os não percorridos, como o seletor de provedor e o de modelo, não foram alterados em comportamento); R-25 PASS (medido); R-27 PASS; R-28 n/a (sem FAQ); R-32 PASS (campos, grip, tooltips por teclado verificados); R-33 ver nota; R-34 PASS (dois temas rodados); R-35 PASS (lista acima); R-37 PASS (`DESIGN.md`); R-39 PASS; R-40 n/a (sem imagens remotas; nenhuma métrica de desempenho foi reportada).
Purpose-Gate: R-01, R-04, R-06, R-07, R-09, R-10, R-12, R-13, R-14, R-19, R-22 PASS com as razões escritas em `DESIGN.md`.
Liveliness: dials declarados e consistentes; um foco por tela; um acento (violeta); motivo de identidade: o A da marca.

## O que não foi verificado, e ressalvas

1. **Nada foi aberto dentro do Tauri.** A interface foi testada no Chrome, com o mock de desenvolvimento e com a CSP injetada por cabeçalho. A CSP real é aplicada pelo Tauri, que também injeta nonces; por isso `style-src` usa `dangerousDisableAssetCspModification` para manter o `'unsafe-inline'` que Monaco e React Flow exigem. Isso precisa de uma passada em `pnpm tauri:dev` e numa build de release, olhando o console do WebView.
2. **Só o provedor demo foi exercitado**, como antes. O estado "No coding agent found" foi coberto por teste de lógica, mas não foi aberto numa tela real.
3. **Itens que dependem de confirmação do dono**: a razão da fonte Geist em `DESIGN.md` foi escrita pelo agente; os tints do `ProviderMark` são um stand-in até haver marcas oficiais; o ícone do app foi gerado do A da marca (reversível com `git checkout src-tauri/icons`).
4. **R-33**: as renomeações em massa de classes (raios, tamanhos de texto, sombras, espaçamento) foram feitas com one-liners de `perl` no terminal, sem deixar nenhum script no repositório; o restante foi editado direto no código-fonte.
5. Os botões `secondary` e `quiet` mantêm a borda hairline (1,4:1): o rótulo de texto os identifica, então a regra de 3:1 para limites de controle não se aplica a eles.
6. O build ainda avisa de chunks acima de 500 kB (Monaco), como antes.
